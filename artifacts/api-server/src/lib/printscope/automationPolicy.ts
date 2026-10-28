import { createHash } from "node:crypto";
import { z } from "zod";
export const TASK_NAME = "Prep Separations- Confirm ART has been approved";
export const FAILURE_STATUS = "PRINT ERROR - REVIEW";
export const defaults = {
  enabled: false, times: ["06:30"], weekdays: [0,1,2,3,4,5,6],
  timezone: "America/New_York", email: "art@mintprintworks.com",
  automaticActions: false, allowedStatusIds: [] as string[], settleMinutes: 10,
  automaticSince: null as string | null,
};
export const settingsInput = z.object({
  version: z.number().int().min(0),
  enabled: z.boolean(), times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).min(1).max(12),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  timezone: z.string().refine(v => {try { new Intl.DateTimeFormat("en-US",{timeZone:v}); return true;} catch {return false;}}),
  email: z.string().email(), automaticActions: z.boolean(),
  allowedStatusIds: z.array(z.string().regex(/^\d+$/)).max(100),
  settleMinutes: z.number().int().min(1).max(120),
}).strict();
export const normalizeName = (s: string) => s.trim().replace(/\s+/g," ").toLowerCase();
export const outputFilename = (s: string) => s.length <= 240 && !/[\\/\x00-\x1f\x7f]/.test(s) && /(?:^|[\s_-])OUTPUT\.ai$/i.test(s);
export const digest = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export function scheduleSlot(settings: typeof defaults, now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:settings.timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23",weekday:"short"}).formatToParts(now).map(x=>[x.type,x.value]));
  const day = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(p.weekday);
  const time = `${p.hour}:${p.minute}`;
  return settings.enabled && settings.weekdays.includes(day) && settings.times.includes(time) ? `${p.year}-${p.month}-${p.day}/${time}/${settings.timezone}` : null;
}
export function invoiceFolder(name: string, visualId: string | number) {
  return new RegExp(`^#${String(visualId).replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}(?=$|[\\s_-])`).test(name);
}
export function dropboxHash(data: Buffer) {
  const hashes: Buffer[] = [];
  for(let i=0;i<data.length;i+=4194304) hashes.push(createHash("sha256").update(data.subarray(i,i+4194304)).digest());
  return digest(Buffer.concat(hashes));
}
