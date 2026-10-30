import { ReplitConnectors } from "@replit/connectors-sdk";
import { pool } from "@workspace/db";
import { getPrintavoClient } from "../printavoGateway";
import { getDropboxMetadata, isDropboxPathWithinRoot, listDropboxFolder, searchDropbox } from "../dropbox";
import { digest, dropboxHash, invoiceFolder, normalizeName, outputFilename, TASK_NAME, safeDownloadUrl } from "./automationPolicy";
import { MAX_BYTES } from "./worker";

const lit = JSON.stringify;
export async function readInvoice(id: string): Promise<any> {
  const client = getPrintavoClient();
  const data: any = await client.query(`query { invoice(id:${lit(id)}) {
    id visualId nickname productionNote status {id name}
    contact {id fullName customer {id companyName}}
    productionFiles(first:25) {nodes {id name fileUrl timestamps {updatedAt createdAt}} pageInfo {hasNextPage endCursor}}
    tasks(first:25) {nodes {id name completed} pageInfo {hasNextPage endCursor}}
  } }`);
  const inv = data.invoice;
  if (!inv) throw new Error("Invoice is unavailable in Printavo.");
  inv.customerName=inv.contact?.customer?.companyName || inv.contact?.fullName || "";
  for (const field of ["productionFiles","tasks"]) {
    let connection = inv[field];
    const seen = new Set<string>();
    while(connection.pageInfo.hasNextPage) {
      const cursor = connection.pageInfo.endCursor;
      if(!cursor || seen.has(cursor) || inv[field].nodes.length >= 2000) throw new Error("Incomplete Printavo file/task listing; review required.");
      seen.add(cursor);
      const fields = field==="tasks" ? "id name completed" : "id name fileUrl timestamps {updatedAt createdAt}";
      const page: any = await client.query(`query { invoice(id:${lit(id)}) { ${field}(first:25,after:${lit(cursor)}) {nodes {${fields}} pageInfo {hasNextPage endCursor}} } }`);
      connection = page.invoice[field]; inv[field].nodes.push(...connection.nodes);
    }
  }
  inv.files = inv.productionFiles.nodes.filter((f: any)=>outputFilename(f.name ?? "")).sort((a: any,b: any)=>a.id.localeCompare(b.id));
  inv.prepTasks = inv.tasks.nodes.filter((t: any)=>normalizeName(t.name)===normalizeName(TASK_NAME));
  return inv;
}
export async function liveStatuses() {
  const nodes: any[] = []; let cursor: string | null = null;
  for(let page=0;page<50;page++) {
    const result: any = await getPrintavoClient().query(`query {statuses(first:25${cursor ? `,after:${lit(cursor)}`:""}) {nodes {id name} pageInfo {hasNextPage endCursor}}}`);
    nodes.push(...result.statuses.nodes);
    if(!result.statuses.pageInfo.hasNextPage) return nodes;
    const next = result.statuses.pageInfo.endCursor;
    if(!next || next===cursor) break;
    cursor = next;
  }
  throw new Error("Incomplete status listing.");
}
export async function downloadOutput(file: any) {
  let url = safeDownloadUrl(file.fileUrl);
  for(let redirects=0;redirects<5;redirects++) {
    const res = await fetch(url,{redirect:"manual",signal:AbortSignal.timeout(60_000)});
    if(res.status>=300 && res.status<400 && res.headers.get("location")) {url=safeDownloadUrl(new URL(res.headers.get("location")!,url).href);await res.body?.cancel();continue;}
    if(!res.ok || !res.body) throw new Error(`Artwork download failed (${res.status}).`);
    if(Number(res.headers.get("content-length") ?? 0)>MAX_BYTES) {await res.body.cancel();throw new Error("OUTPUT exceeds 50 MiB.");}
    const chunks: Buffer[]=[]; let size=0;
    for await (const chunk of res.body as any) {
      size+=chunk.length; if(size>MAX_BYTES) {await res.body.cancel().catch(()=>{});throw new Error("OUTPUT exceeds 50 MiB.");}
      chunks.push(Buffer.from(chunk));
    }
    const bytes=Buffer.concat(chunks);
    if(!bytes.length || bytes.subarray(0,5).toString()!=="%PDF-") throw new Error("OUTPUT must be a PDF-compatible Illustrator file.");
    return {bytes,sha:digest(bytes)};
  }
  throw new Error("Too many artwork redirects.");
}
export async function findInvoiceFolder(inv: any) {
  const customerId=inv.contact?.customer?.id;
  if(!customerId) throw new Error("Invoice customer identity is missing.");
  const linked=(await pool.query("SELECT dropbox_id FROM customer_dropbox_folders WHERE printavo_customer_id=$1",[customerId])).rows[0];
  let root: any;
  if(linked) root=await getDropboxMetadata(linked.dropbox_id);
  else {
    const name=inv.contact.customer.companyName || inv.customerName;
    if(!name) throw new Error("Customer name is missing.");
    const result=await searchDropbox("",name,50);
    if(result.has_more) throw new Error("Customer-folder search is ambiguous; link the customer Dropbox folder first.");
    const matches=result.matches.map(x=>x.metadata?.metadata).filter(x=>x?.[".tag"]==="folder" && normalizeName(x.name)===normalizeName(name));
    if(matches.length!==1) throw new Error("Link the correct customer Dropbox folder; no unique exact customer-name match.");
    root=matches[0];
  }
  if(root[".tag"]!=="folder" || !root.path_lower) throw new Error("Customer Dropbox folder is unavailable.");
  const matches: any[]=[]; let cursor: string | undefined;
  // Invoice folders are direct children of the verified customer folder.
  for(let page=0;page<100;page++) {
    const result=await listDropboxFolder({path:root.id,cursor,limit:100});
    matches.push(...result.entries.filter(x=>x[".tag"]==="folder" && invoiceFolder(x.name,inv.visualId)));
    if(!result.has_more) {
      if(matches.length!==1) throw new Error("Expected one existing #invoice folder within the customer folder; found "+matches.length+".");
      const folder=await getDropboxMetadata(matches[0].id);
      if(!folder.path_lower || !isDropboxPathWithinRoot(folder.path_lower,root.path_lower)) throw new Error("Invoice folder moved outside the customer folder.");
      return {id:folder.id,path:folder.path_display ?? folder.path_lower,rootId:root.id,rootPath:root.path_lower};
    }
    cursor=result.cursor;
  }
  throw new Error("Customer-folder listing exceeded safety limit.");
}
export async function dropboxRpc(path: string, body: any) {
  const response=await new ReplitConnectors().proxy("dropbox",path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  if(!response.ok) {
    const text=await response.text();
    if(response.status===401 || response.status===403 || text.includes("missing_scope")) throw new Error("Dropbox write permission is required. Reconnect with files.content.write; source files have not been removed.");
    throw new Error(`Dropbox operation failed (${response.status}).`);
  }
  return response.json() as Promise<any>;
}
export async function uploadLink(path: string) {
  const data=await dropboxRpc("/2/files/get_temporary_upload_link",{commit_info:{path,mode:"add",autorename:false,mute:true,strict_conflict:true},duration:300});
  if(typeof data.link!=="string" || new URL(data.link).protocol!=="https:" || !new URL(data.link).hostname.endsWith(".dropboxapi.com")) throw new Error("Invalid Dropbox upload destination.");
  return data.link as string;
}
export function archivePath(folder: {path:string}, name: string, sha: string) {
  return `${folder.path}/${name.slice(0,-3).slice(0,160)}__sepscope_${sha.slice(0,16)}.ai`;
}
export async function archiveFile(folder: any, name: string, bytes: Buffer, sha: string) {
  const current=await getDropboxMetadata(folder.id), root=await getDropboxMetadata(folder.rootId);
  if(!current.path_lower || !root.path_lower || current.path_lower!==folder.path.toLowerCase() ||
    !isDropboxPathWithinRoot(current.path_lower,root.path_lower)) throw new Error("Dropbox destination changed; preview again.");
  const path=archivePath(folder,name,sha);
  const expectedHash=dropboxHash(bytes);
  const verify=(file:any)=>{
    if(file?.[".tag"]!=="file" || !file.id || file.path_lower!==path.toLowerCase() ||
      file.size!==bytes.length || file.content_hash!==expectedHash) {
      throw new Error("Dropbox copy verification failed (path, size or content hash mismatch); Printavo source retained.");
    }
    return {id:file.id,path:file.path_display,contentHash:file.content_hash};
  };
  let existing: any;
  try {existing=await getDropboxMetadata(path);} catch(e: any) {
    if(e.status!==409 || !e.message.includes("not_found")) throw e;
  }
  if(existing) {
    return verify(existing);
  }
  const link=await uploadLink(path);
  const response=await fetch(link,{method:"POST",headers:{"Content-Type":"application/octet-stream"},body:new Uint8Array(bytes),signal:AbortSignal.timeout(120_000)});
  if(!response.ok) throw new Error(`Dropbox upload not confirmed (${response.status}); manual reconciliation required.`);
  const uploaded: any=await response.json();
  // Temporary uploads return {"content-hash": ...}, NOT FileMetadata/id.
  if(uploaded?.["content-hash"]!==expectedHash) throw new Error("Dropbox upload content hash not confirmed; Printavo source retained.");
  try {
    return verify(await getDropboxMetadata(path));
  } catch(e:any) {
    throw new Error(`Dropbox upload accepted, but archive verification failed: ${e.message}. Printavo source retained; manual reconciliation required.`);
  }
}
