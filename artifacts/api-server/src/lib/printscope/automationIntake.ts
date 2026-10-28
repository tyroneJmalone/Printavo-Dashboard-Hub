import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { getPrivateObjectDir } from "../objectStorage";
import { getPrintavoClient } from "../printavoGateway";
import { activeRules } from "./rules";
import { environment, objectFile, ensurePrintscopeAvailable } from "./worker";
import { digest } from "./automationPolicy";
import { readInvoice, downloadOutput } from "./automationProviders";
import { getSettings } from "./automationStore";
import { logger } from "../logger";

export async function queueScan(actor: string, slot="manual:"+randomUUID()) {
  const settings=await getSettings();
  if(!settings.allowedStatusIds.length) throw new Error("Choose eligible source statuses in SepScope settings first.");
  const caps=await ensurePrintscopeAvailable();
  if(!caps.available) throw new Error("SepScope inspection engine is unavailable.");
  const id=randomUUID();
  const created=await pool.query(`INSERT INTO sepscope_automation_runs(id,environment,slot,state,detail)
    VALUES($1,$2,$3,'queued',$4) ON CONFLICT(environment,slot) DO NOTHING RETURNING id`,
    [id,environment,slot,JSON.stringify({actor,settingsVersion:settings.version})]);
  if(!created.rowCount) return {alreadyScheduled:true};
  void executeScan(id,actor,settings).catch(err=>logger.error({err},"SepScope scheduled intake failed"));
  return {id,state:"queued"};
}
async function executeScan(runId: string, actor: string, settings: Awaited<ReturnType<typeof getSettings>>) {
  const c=await pool.connect();
  let locked=false;
  const summary={invoices:0,queued:0,unchanged:0,held:0,errors:[] as string[]};
  try {
    locked=(await c.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked",["sepscope-scan:"+environment])).rows[0].locked;
    if(!locked) {await pool.query("UPDATE sepscope_automation_runs SET state='skipped',completed_at=now(),detail=detail||$2::jsonb WHERE id=$1",[runId,JSON.stringify({message:"Another scan is running."})]);return;}
    await pool.query("UPDATE sepscope_automation_runs SET state='interrupted',completed_at=now(),detail=detail||'{\"message\":\"Interrupted scan; next scan safely deduplicates inspected file versions.\"}' WHERE environment=$1 AND state IN ('running','queued') AND id<>$2",[environment,runId]);
    await pool.query("UPDATE sepscope_automation_runs SET state='running' WHERE id=$1",[runId]);
    const rules=await activeRules();
    const orders:string[]=[]; let cursor:string|null=null;
    const seen=new Set<string>();
    for(let page=0;page<100;page++) {
      const data:any=await getPrintavoClient().query(`query {invoices(first:50,statusIds:${JSON.stringify(settings.allowedStatusIds)}${cursor ? `,after:${JSON.stringify(cursor)}`:""}) {nodes {id} pageInfo {hasNextPage endCursor}}}`);
      for(const order of data.invoices.nodes) if(!seen.has(order.id)) {seen.add(order.id);orders.push(order.id);}
      if(!data.invoices.pageInfo.hasNextPage) break;
      const next=data.invoices.pageInfo.endCursor;
      if(!next || next===cursor || page===99) throw new Error("Invoice discovery incomplete; narrow eligible statuses.");
      cursor=next;
    }
    for(const orderId of orders) {
      try {
        const current=await getSettings();
        if(current.version!==settings.version) throw new Error("Settings changed during scan; remaining intake stopped.");
        const inv=await readInvoice(orderId);
        if(!settings.allowedStatusIds.includes(inv.status.id) || inv.prepTasks.length!==1 || inv.prepTasks[0].completed) {summary.held++;continue;}
        summary.invoices++;
        for(const file of inv.files) {
          const metadata={visualId:String(inv.visualId),customerName:inv.customerName,customerId:inv.contact?.customer?.id,filename:file.name,sourceStatusId:inv.status.id};
          const changed=Date.parse(file.timestamps?.updatedAt ?? file.timestamps?.createdAt ?? "");
          if(!Number.isFinite(changed) || Date.now()-changed<settings.settleMinutes*60_000) {summary.held++;continue;}
          try {
            const {bytes,sha}=await downloadOutput(file);
            const existing=(await pool.query(`SELECT id FROM sepscope_automation_intake WHERE environment=$1 AND order_id=$2 AND file_id=$3 AND revision=$4 AND job_id IS NOT NULL`,[environment,orderId,file.id,sha])).rowCount;
            if(existing) {summary.unchanged++;continue;}
            const jobId=randomUUID(),id=randomUUID();
            const dest=`${getPrivateObjectDir()}/printscope/${environment}/automation/${orderId}/${file.id}/${sha}.ai`;
            try {await objectFile(dest).save(bytes,{resumable:false,preconditionOpts:{ifGenerationMatch:0},contentType:"application/pdf"});}
            catch(e:any) {if(Number(e.code)!==412) throw e;}
            const [meta]=await objectFile(dest).getMetadata();
            await c.query("BEGIN");
            const inserted=await c.query(`INSERT INTO sepscope_automation_intake(id,environment,run_id,order_id,file_id,revision,job_id,metadata)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,
              [id,environment,runId,orderId,file.id,sha,jobId,JSON.stringify(metadata)]);
            if(inserted.rowCount) {
              await c.query(`INSERT INTO printscope_jobs(id,environment,state,filename,byte_size,content_type,source_path,generation,sha256,rule_version_id,submitted_by)
                VALUES($1,$2,'queued',$3,$4,'application/pdf',$5,$6,$7,$8,$9)`,
                [jobId,environment,file.name,bytes.length,dest,String(meta.generation),sha,rules.id,actor]);
              summary.queued++;
            } else summary.unchanged++;
            await c.query("COMMIT");
          } catch(e:any) {
            await c.query("ROLLBACK");
            const error=String(e.message).slice(0,500); summary.errors.push(`#${inv.visualId} ${file.name}: ${error}`);
            await pool.query(`INSERT INTO sepscope_automation_intake(id,environment,run_id,order_id,file_id,revision,metadata,error)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
              [randomUUID(),environment,runId,orderId,file.id,"error:"+digest(JSON.stringify([file.name,file.timestamps])),JSON.stringify(metadata),error]);
          }
        }
      } catch(e:any) {
        summary.errors.push(`${orderId}: ${String(e.message).slice(0,500)}`);
        if((await getSettings()).version!==settings.version) break;
      }
    }
    await pool.query("UPDATE sepscope_automation_runs SET state=$2,completed_at=now(),detail=detail||$3::jsonb WHERE id=$1",[runId,summary.errors.length?"partial":"completed",JSON.stringify(summary)]);
  } catch(e:any) {
    await c.query("ROLLBACK");
    await pool.query("UPDATE sepscope_automation_runs SET state='failed',completed_at=now(),detail=detail||$2::jsonb WHERE id=$1",[runId,JSON.stringify({...summary,error:String(e.message).slice(0,500)})]);
  } finally {
    if(locked) await c.query("SELECT pg_advisory_unlock(hashtext($1))",["sepscope-scan:"+environment]);
    c.release();
  }
}
