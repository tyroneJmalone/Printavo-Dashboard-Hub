export const state: any = {};
export function reset() {
  state.settings = new Map(); state.categoryCalls = 0; state.statusCalls = 0;
  state.unknown = false; state.active = false; state.dryRun = false; state.latest = null;
  state.job = { id: "job", runId: "run", printavoOrderId: "invoice", visualId: "22251", nickname: "123456 Shop PRINT: Front",
    docType: "workorder", status: "printed", printnodeJobId: "123", sourceStatusId: "source", sourceStatusName: "MERCH - Ordered" };
  state.live = { orderId: "invoice", visualId: 22251, statusId: "source", statusName: "MERCH - Ordered" };
  state.node = { id: "invoice", visualId: 22251, nickname: "123456 Shop PRINT: Front", lineItemGroups: {
    pageInfo: {hasNextPage:false}, nodes: [{ id:"group", lineItems: {pageInfo:{hasNextPage:false}, nodes:[
      {id:"line",itemNumber:"5000",color:"Black",items:2,category:null}]},
    imprints:{pageInfo:{hasNextPage:false},nodes:[]} }] } };
  state.config = { routingMode:"conditional", routingRules:[{id:"rule",enabled:true,decoration:"any",
    nicknameKeywords:[],sourceStatusIds:["source"],requiredMethods:["print"],dueComparator:null,dueBusinessDays:null,
    statusId:"target",statusName:"MERCH - Print Waiting 4 Blanks",merchCategoryAction:"all_lines"}] };
}
reset();
const copy = (v: any) => JSON.parse(JSON.stringify(v));
export const pool = { query: async (q: string, p: any[]) => {
  const found = state.settings.get(p[0]);
  if (q.startsWith("SELECT 1")) return {rowCount:found ? 1 : 0, rows:found ? [{}] : []};
  if (q.startsWith("INSERT")) {
    if (found) return {rowCount:0,rows:[]};
    state.settings.set(p[0],JSON.parse(p[1])); return {rowCount:1,rows:[{key:p[0]}]};
  }
  if (q.startsWith("DELETE")) {
    if (found?.previewId===p[1]) state.settings.delete(p[0]);
    return {rowCount:1,rows:[]};
  }
  if (q.startsWith("UPDATE") && q.includes("RETURNING value")) {
    if (!found || found.actor!==p[1] || found.state!=="preview" || found.configHash!==p[2] || Date.parse(found.expiresAt)<=Date.now()) return {rowCount:0,rows:[]};
    found.state="applying"; return {rowCount:1,rows:[{value:copy(found)}]};
  }
  if (q.startsWith("UPDATE")) {state.settings.set(p[0],JSON.parse(p[1]));return {rowCount:1,rows:[]};}
  if(q.startsWith("SELECT value")) return {rows:[...state.settings.values()].filter((v:any)=>v.runId===p[1]).map(value=>({value:copy(value)}))};
  throw Error("Unexpected SQL "+q);
}};
export const db = {select:(shape:any)=> {
  const result = () => shape?.job ? [{job:copy(state.job),dryRun:state.dryRun}] :
    shape?.id ? (state.active ? [{id:"active"}] : []) : [copy(state.latest ?? state.job)];
  const chain:any = {from:()=>chain,innerJoin:()=>chain,where:()=>chain,orderBy:()=>chain,limit:()=>chain,
    then:(yes:any,no:any)=>Promise.resolve(result()).then(yes,no)};
  return chain;
}};
export const getAutoPrintConfig = async()=>copy(state.config);
export const getPrintavoClient = ()=>({query:async()=>({invoice:copy(state.node)})});
export const fetchLiveOrderStatus = async()=>copy(state.live);
export const liveCategories = async()=>[{id:"cat",name:"Screen Printing"}];
export const previewReview = async()=>({previewId:"review",lines:[{eligible:true,statusId:state.live.statusId}]});
export const commitReview = async()=>{state.categoryCalls++;return {results:[{outcome:state.unknown?"unknown":"updated"}]};};
export const startPqStatusJob = async(trigger:any,inputs:any)=>{
  state.statusCalls++;state.statusInputs=inputs;state.live.statusId="target";
  return {status:"started",job:{id:"status-job"}};
};
export const getPqStatusJob = async()=>({id:"status-job",status:"success",lines:[{orderId:"invoice",status:"done"}]});
