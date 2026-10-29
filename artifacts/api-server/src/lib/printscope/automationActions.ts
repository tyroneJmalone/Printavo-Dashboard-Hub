import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { statusUpdateMutation, taskUpdateMutation } from "@workspace/printavo";
import { getPrintavoClient } from "../printavoGateway";
import { digest, FAILURE_STATUS, normalizeName } from "./automationPolicy";
import { readInvoice, downloadOutput, findInvoiceFolder, liveStatuses, archiveFile, archivePath, uploadLink } from "./automationProviders";
import { getSettings } from "./automationStore";
import { environment } from "./worker";
import { assertTestScope, assertTestFiles, TEST_ORDER_ID, TEST_VISUAL_ID } from "./testMode";
import { deliverNotification } from "./notificationDelivery";

export async function actionPreview(orderId: string, checkDropbox = true) {
  const settings=await getSettings(), inv=await readInvoice(orderId);
  const testMode=environment==="development" && settings.restrictedTestMode===true;
  const blockers:string[]=[]; const files:any[]=[];
  if(testMode && (orderId!==TEST_ORDER_ID || String(inv.visualId)!==TEST_VISUAL_ID)) blockers.push("Restricted tests only allow invoice #20625.");
  if(!settings.allowedStatusIds.includes(inv.status.id)) blockers.push("Invoice is no longer in an eligible source status.");
  if(inv.prepTasks.length!==1 || inv.prepTasks[0].completed) blockers.push("Expected exactly one incomplete Prep Separations task.");
  if(!inv.files.length) blockers.push("No current OUTPUT.ai production files.");
  for(const f of inv.files) {
    try {
      const {sha}=await downloadOutput(f);
      const row=(await pool.query(`SELECT i.job_id,j.state,j.result,j.rule_version_id
        FROM sepscope_automation_intake i JOIN printscope_jobs j ON j.id=i.job_id
        WHERE i.environment=$1 AND i.order_id=$2 AND i.file_id=$3 AND i.revision=$4 ORDER BY i.created_at DESC LIMIT 1`,
        [environment,orderId,f.id,sha])).rows[0];
      files.push({id:f.id,name:f.name,sha,jobId:row?.job_id??null,state:row?.state??"not_inspected",verdict:row?.result?.verdict??null,inspectionComplete:row?.result?.completeness?.complete===true,resultHash:row?digest(JSON.stringify(row.result)):null,ruleVersion:row?.rule_version_id??null});
    } catch(e:any) {files.push({id:f.id,name:f.name,state:"unavailable",verdict:null,error:String(e.message)});}
  }
  const unsettled=inv.files.some((f:any)=>{
    const time=Date.parse(f.timestamps?.updatedAt??f.timestamps?.createdAt??"");
    return !Number.isFinite(time) || Date.now()-time<settings.settleMinutes*60_000;
  });
  if(unsettled) blockers.push("Some output files are still within the upload settling period.");
  const prior=(await pool.query("SELECT id FROM sepscope_automation_actions WHERE environment=$1 AND order_id=$2 AND state IN ('running','review_required') LIMIT 1",[environment,orderId])).rows[0];
  if(prior) blockers.push("A previous action needs manual reconciliation. No further upstream actions will run.");
  const commonClear=blockers.length===0;
  const statuses=await liveStatuses();
  const failureStatuses=statuses.filter((s:any)=>normalizeName(s.name)===normalizeName(FAILURE_STATUS));
  const canFail=commonClear && failureStatuses.length===1 && files.some(f=>f.state==="completed" && f.verdict==="fail") && files.every(f=>f.state==="completed");
  if(failureStatuses.length!==1) blockers.push("Failure status does not resolve to one live Printavo status.");
  let folder:any=null;
  if(checkDropbox) {
    try {
      folder=await findInvoiceFolder(inv);
      // Permission preflight only: issuing a temporary upload URL uploads nothing.
      if(files[0]?.sha) await uploadLink(archivePath(folder,files[0].name,files[0].sha));
    } catch(e:any) {blockers.push(String(e.message));}
  }
  const allPass=files.length>0 && files.every(f=>f.state==="completed" && f.verdict==="pass" && f.inspectionComplete);
  if(!allPass) blockers.push("Pass actions require every current OUTPUT file to have a passing inspection.");
  const canPass=checkDropbox && commonClear && !!folder && allPass && blockers.length===0;
  const imprint=(await pool.query(`SELECT count(*)::int AS count FROM pv_imprints WHERE order_id=$1 AND matrix_name ~* '(screen|print)'`,[orderId])).rows[0];
  const token=digest(JSON.stringify({orderId,customerId:inv.contact?.customer?.id,status:inv.status.id,files,task:inv.prepTasks,
    settingsVersion:settings.version,folder:checkDropbox?folder:null,failureStatus:failureStatuses[0]?.id,testMode,email:settings.email}));
  return {token,orderId,visualId:String(inv.visualId),customerName:inv.customerName,statusName:inv.status.name,
    statusId:inv.status.id,customerId:inv.contact?.customer?.id,files,task:inv.prepTasks.length===1?inv.prepTasks[0]:null,folder,
    blockers,canPass,canFail,testMode,emailRecipient:settings.email,printImprints:imprint?.count??null,completeness:"Staff confirmation required",
    failureStatusId:failureStatuses[0]?.id,settingsVersion:settings.version};
}
export async function approveActions(orderId: string, input:{token:string;decision:"pass"|"fail"|"email";confirmComplete:boolean;note:string;testMode?:boolean;selectedFileIds?:string[]}, actor:string, automatic=false) {
  const settings=await getSettings();
  if(environment!=="production") assertTestScope(environment,settings,orderId,automatic,input.testMode===true);
  else if(input.testMode || input.decision==="email") throw new Error("Restricted test requests cannot execute in production.");
  const c=await pool.connect();
  let locked=false;
  try {
    locked=(await c.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked",["sepscope-action:"+environment+":"+orderId])).rows[0].locked;
    if(!locked) throw new Error("Another reviewer is processing this invoice.");
    const preview=await actionPreview(orderId,!automatic);
    if(environment!=="production") {
      if(preview.visualId!==TEST_VISUAL_ID) throw new Error("Test invoice identity changed.");
      assertTestFiles(input.selectedFileIds,preview.files);
    }
    if(preview.token!==input.token) throw new Error("Invoice, file, inspection, settings or folder changed. Refresh the preview.");
    if(input.decision==="pass" && (!preview.canPass || !input.confirmComplete || automatic)) throw new Error("Pass requires all files passing, a verified destination and staff confirmation of completeness.");
    if(input.decision==="fail" && !preview.canFail) throw new Error("Failure action is not currently eligible.");
    if(input.decision==="email" && !preview.canFail) throw new Error("A completed failed inspection is required to test its notification.");
    const id=randomUUID();
    const detail:any={preview,note:input.note,automatic,testMode:input.testMode===true,steps:[]};
    const actionToken=input.testMode ? digest(input.token+":"+input.decision) : input.token;
    const inserted=await pool.query(`INSERT INTO sepscope_automation_actions(id,environment,order_id,token,decision,state,reviewed_by,detail)
      VALUES($1,$2,$3,$4,$5,'running',$6,$7) ON CONFLICT(environment,token) DO NOTHING RETURNING id`,
      [id,environment,orderId,actionToken,input.decision,actor,JSON.stringify(detail)]);
    if(!inserted.rowCount) throw new Error("This review was already submitted; inspect its audit record.");
    const persist=async()=>{await pool.query("UPDATE sepscope_automation_actions SET detail=$2 WHERE id=$1",[id,JSON.stringify(detail)]);};
    const step=async(name:string,run:()=>Promise<any>)=>{
      const item:any={name,state:"attempting",startedAt:new Date().toISOString()};
      detail.steps.push(item); await persist(); // durable claim before every external write
      const result=await run(); item.state="confirmed";item.result=result;await persist();return result;
    };
    try {
      const requireCurrent=async(expectedIds=preview.files.map(f=>f.id))=>{
        const live=await readInvoice(orderId);
        if(live.status.id!==preview.statusId || live.contact?.customer?.id!==preview.customerId ||
          live.prepTasks.length!==1 || live.prepTasks[0].id!==preview.task.id || live.prepTasks[0].completed ||
          JSON.stringify(live.files.map((f:any)=>f.id))!==JSON.stringify(expectedIds)) throw new Error("Invoice changed during processing; remaining actions held.");
        const current=await getSettings();
        if(environment!=="production") assertTestScope(environment,current,orderId,automatic,input.testMode===true);
        if(current.version!==preview.settingsVersion) throw new Error("Automation settings changed; remaining actions held.");
        return live;
      };
      if(input.decision==="email") {
        await requireCurrent();
        await step("Send restricted-test failure email",async()=>{
          const emailId=randomUUID();
          const body={from:`Mint Printworks Hub <${process.env.FROM_EMAIL??"noreply@mintprintworks.com"}>`,
            to:settings.email,subject:"[TEST] SepScope inspection failed — #20625",
            text:`Restricted development test for invoice #20625.\n\n${preview.files.filter(f=>f.verdict==="fail").map(f=>"- "+f.name).join("\n")}\n\nOpen SepScope inspection findings in the development preview.\nThis notification does not change the invoice status, complete its task, or move files.\nPrintavo: https://www.printavo.com/invoices/${TEST_ORDER_ID}`};
          await pool.query("INSERT INTO sepscope_automation_emails(id,environment,batch_key,state,body) VALUES($1,$2,$3,'sending',$4)",[emailId,environment,"test:"+id,JSON.stringify(body)]);
          try {
            await deliverNotification(body,emailId);
            await pool.query("UPDATE sepscope_automation_emails SET state='sent' WHERE id=$1",[emailId]);
            return {recipient:settings.email,accepted:true};
          } catch(e) {
            await pool.query("UPDATE sepscope_automation_emails SET state='review_required',error='Test delivery uncertain; verify provider before retrying.' WHERE id=$1",[emailId]);
            throw e;
          }
        });
      } else if(input.decision==="fail") {
        const live=await requireCurrent();
        for(const f of live.files) if((await downloadOutput(f)).sha!==preview.files.find(x=>x.id===f.id)?.sha) throw new Error("Artwork changed since review.");
        await step("Set PRINT ERROR - REVIEW",async()=>{
          await getPrintavoClient().mutate(statusUpdateMutation(orderId,preview.failureStatusId));
          const updated=await readInvoice(orderId);
          if(updated.status.id!==preview.failureStatusId) throw new Error("Status update not confirmed.");
          return {statusId:updated.status.id};
        });
      } else {
        // Archive every file before removing ANY production attachment.
        const archives=new Map<string,any>();
        for(const f of preview.files) {
          const live=await requireCurrent();
          const bytes=await downloadOutput(live.files.find((x:any)=>x.id===f.id));
          if(bytes.sha!==f.sha) throw new Error("Artwork changed since review.");
          archives.set(f.id,await step(`Archive ${f.name}`,()=>archiveFile(preview.folder,f.name,bytes.bytes,f.sha)));
        }
        const remaining=preview.files.map(f=>f.id);
        for(const f of preview.files) {
          const live=await requireCurrent(remaining);
          const bytes=await downloadOutput(live.files.find((x:any)=>x.id===f.id));
          if(bytes.sha!==f.sha || !archives.has(f.id)) throw new Error("Source no longer matches verified archive.");
          // Reverify the archived copy and customer folder immediately before removal.
          const destination=await findInvoiceFolder(live);
          if(destination.id!==preview.folder.id || destination.path!==preview.folder.path) throw new Error("Archive destination changed.");
          await archiveFile(destination,f.name,bytes.bytes,f.sha);
          await step(`Remove Printavo attachment ${f.name}`,async()=>{
            const result:any=await getPrintavoClient().mutate(`mutation {productionFileDelete(id:${JSON.stringify(f.id)}) {id}}`);
            if(String(result.productionFileDelete?.id)!==f.id) throw new Error("Attachment removal not confirmed.");
            return {fileId:f.id,archive:archives.get(f.id)};
          });
          remaining.splice(remaining.indexOf(f.id),1);
        }
        await requireCurrent([]);
        await step("Complete Prep Separations task",async()=>{
          const result:any=await getPrintavoClient().mutate(taskUpdateMutation(preview.task.id,{completed:true}));
          if(result.taskUpdate?.completed!==true) throw new Error("Task completion not confirmed.");
          return {taskId:preview.task.id};
        });
      }
      await pool.query("UPDATE sepscope_automation_actions SET state='completed',completed_at=now(),detail=$2 WHERE id=$1",[id,JSON.stringify(detail)]);
      return {action:{id,state:"completed",detail}};
    } catch(e:any) {
      detail.error=String(e.message).slice(0,1000);
      await pool.query("UPDATE sepscope_automation_actions SET state='review_required',completed_at=now(),detail=$2 WHERE id=$1",[id,JSON.stringify(detail)]);
      return {action:{id,state:"review_required",detail}};
    }
  } finally {
    if(locked) await c.query("SELECT pg_advisory_unlock(hashtext($1))",["sepscope-action:"+environment+":"+orderId]);
    c.release();
  }
}
