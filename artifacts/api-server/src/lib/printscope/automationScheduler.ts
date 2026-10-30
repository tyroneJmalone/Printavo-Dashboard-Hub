import { randomUUID } from "node:crypto";
import { deliverNotification } from "./notificationDelivery";
import { pool } from "@workspace/db";
import { environment } from "./worker";
import { getSettings } from "./automationStore";
import { scheduleSlot, digest } from "./automationPolicy";
import { queueScan } from "./automationIntake";
import { actionPreview, approveActions } from "./automationActions";
import { logger } from "../logger";
import { escapeHtml, reviewLinks } from "./inspectionCommunication";

export async function automationTick() {
  if(environment!=="production") return;
  const c=await pool.connect();
  let locked=false;
  try {
    locked=(await c.query("SELECT pg_try_advisory_lock(hashtext('sepscope-automation-tick')) AS locked")).rows[0].locked;
    if(!locked) return;
    const settings=await getSettings();
    const slot=scheduleSlot(settings);
    if(slot && settings.updatedBy) await queueScan(settings.updatedBy,slot);
    // One notification per invoice/run. Wait for all jobs in that invoice's run.
    const batches=(await c.query(`SELECT i.run_id,i.order_id,jsonb_agg(jsonb_build_object(
      'jobId',j.id,'filename',j.filename,'verdict',j.result->>'verdict','result',j.result,
      'visualId',i.metadata->>'visualId','customerName',i.metadata->>'customerName')) AS files
      FROM sepscope_automation_intake i JOIN printscope_jobs j ON j.id=i.job_id
      JOIN sepscope_automation_runs r ON r.id=i.run_id
      WHERE i.environment=$1 AND r.state IN ('completed','partial')
      AND NOT EXISTS(SELECT 1 FROM sepscope_automation_emails e WHERE e.environment=i.environment AND e.batch_key=i.run_id::text||':'||i.order_id)
      GROUP BY i.run_id,i.order_id HAVING bool_and(j.state IN ('completed','failed'))
      AND bool_or(j.state='completed' AND j.result->>'verdict'='fail')`,[environment])).rows;
    for(const batch of batches) {
      const key=batch.run_id+":"+batch.order_id;
      const failures=batch.files.filter((f:any)=>f.verdict==="fail");
      const first=failures[0];
      const lines=failures.map((f:any)=>{
        const rules=f.result?.results ?? [];
        const findings=Array.isArray(rules) ? rules.filter((r:any)=>["fail","error"].includes(r.verdict??r.status??r.severity)).slice(0,8).map((r:any)=>r.title??r.name??r.code??"Failed check").join(", ") : "";
        return `- ${f.filename}${findings?": "+findings:" — open SepScope for findings"}`;
      });
      const links=reviewLinks(batch.order_id,failures);
      const message=`Invoice #${first.visualId} — ${first.customerName??""}\n\n${lines.join("\n")}\n\n${settings.automaticActions ? "Automatic failure actions enabled; check the action log for the confirmed outcome." : "Awaiting staff review — this notification has not changed the invoice status."}`;
      const body={from:`Mint Printworks Hub <${process.env.FROM_EMAIL??"noreply@mintprintworks.com"}>`,to:settings.email,
        subject:`SepScope inspection failed — #${first.visualId}`,
        text:`${message}\n\n${links.text}\n\nPrintavo: https://www.printavo.com/invoices/${batch.order_id}`,
        html:`<p>${escapeHtml(message).replace(/\n/g,"<br>")}</p>${links.html}<p><a href="https://www.printavo.com/invoices/${encodeURIComponent(batch.order_id)}">View Printavo invoice</a></p>`};
      await c.query(`INSERT INTO sepscope_automation_emails(id,environment,batch_key,state,body) VALUES($1,$2,$3,'pending',$4) ON CONFLICT DO NOTHING`,
        [randomUUID(),environment,key,JSON.stringify(body)]);
    }
    const emails=(await c.query("SELECT * FROM sepscope_automation_emails WHERE environment=$1 AND state IN ('pending','sending') ORDER BY created_at LIMIT 20",[environment])).rows;
    for(const email of emails) {
      if(Date.now()-new Date(email.created_at).getTime()>23*3600_000) {
        await c.query("UPDATE sepscope_automation_emails SET state='review_required',error='Delivery not confirmed within safe retry window; verify provider delivery manually.' WHERE id=$1",[email.id]);continue;
      }
      await c.query("UPDATE sepscope_automation_emails SET state='sending' WHERE id=$1",[email.id]);
      try {
        await deliverNotification(email.body,email.id);
        await c.query("UPDATE sepscope_automation_emails SET state='sent',error=NULL WHERE id=$1",[email.id]);
      } catch(e:any) {await c.query("UPDATE sepscope_automation_emails SET state='pending',error=$2 WHERE id=$1",[email.id,String(e.message).slice(0,500)]);}
    }
    if(settings.automaticActions && settings.automaticSince && settings.updatedBy) {
      // Only failures discovered AND completed after activation; never release old backlog.
      const failures=(await c.query(`SELECT DISTINCT i.order_id FROM sepscope_automation_intake i JOIN printscope_jobs j ON j.id=i.job_id
        WHERE i.environment=$1 AND i.created_at>$2 AND j.completed_at>$2 AND j.state='completed' AND j.result->>'verdict'='fail'
        AND NOT EXISTS(SELECT 1 FROM sepscope_automation_actions a WHERE a.environment=i.environment AND a.order_id=i.order_id)
        LIMIT 20`,[environment,settings.automaticSince])).rows;
      for(const row of failures) {
        try {
          const preview=await actionPreview(row.order_id,false);
          if(preview.canFail) await approveActions(row.order_id,{token:preview.token,decision:"fail",confirmComplete:false,note:"Automatic failure action; enabled after this file was discovered."},settings.updatedBy,true);
        } catch(e:any) {logger.warn({orderId:row.order_id,message:String(e.message)},"SepScope automatic action held");}
      }
    }
  } finally {
    if(locked) await c.query("SELECT pg_advisory_unlock(hashtext('sepscope-automation-tick'))");
    c.release();
  }
}
export function startSepscopeAutomation() {
  if(environment!=="production") return;
  let running=false;
  const tick=async()=>{if(running)return;running=true;try{await automationTick();}catch(e){logger.error({err:e},"SepScope automation tick failed");}finally{running=false;}};
  // Current civil minute only; no restart catch-up, unique slot prevents DST repetition.
  setInterval(()=>void tick(),30_000).unref();
}
