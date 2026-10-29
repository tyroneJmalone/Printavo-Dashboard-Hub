import { ReplitConnectors } from "@replit/connectors-sdk";
import { digest } from "./automationPolicy";

/** Shared provider call for production notifications and explicitly approved tests. */
export async function deliverNotification(body: unknown, emailId: string) {
  const response=await new ReplitConnectors().proxy("resend","/emails",{
    method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":digest("sepscope:"+emailId)},
    body:JSON.stringify(body),
  });
  if(!response.ok || !(await response.json() as any).id) throw new Error("Email provider did not confirm acceptance.");
}
