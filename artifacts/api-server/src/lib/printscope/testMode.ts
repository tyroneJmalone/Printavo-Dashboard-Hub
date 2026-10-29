export const TEST_ORDER_ID = "21512127";
export const TEST_VISUAL_ID = "20625";
export function assertTestScope(environment:string,settings:any,orderId:string,automatic:boolean,explicit:boolean) {
  if(environment!=="development" || !settings.restrictedTestMode || orderId!==TEST_ORDER_ID ||
    automatic || !explicit || settings.enabled || settings.automaticActions)
    throw new Error("Restricted live tests require development, enabled test mode, invoice #20625, explicit confirmation, and scheduled/automatic actions off.");
}
export function assertTestFiles(selected:string[]|undefined,files:{id:string}[]) {
  if(!selected?.length || new Set(selected).size!==selected.length ||
    [...selected].sort().join(",")!==files.map(f=>f.id).sort().join(","))
    throw new Error("Explicitly select every current OUTPUT file as a test attachment. Remove unrelated OUTPUT files from this test before continuing.");
}
