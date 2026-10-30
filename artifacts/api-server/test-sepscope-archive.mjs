import {build} from "esbuild";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
const bytes=Buffer.from("fixture artwork");
const hash=createHash("sha256").update(createHash("sha256").update(bytes).digest()).digest("hex");
const folder={id:"folder",rootId:"root",path:"/Client/#1"};
let h;
await build({entryPoints:["src/lib/printscope/automationProviders.ts"],absWorkingDir:import.meta.dirname,outfile:"/tmp/sepscope-archive.mjs",bundle:true,platform:"node",format:"esm",plugins:[{name:"mock-external",setup(b){
  b.onResolve({filter:/^@workspace\/db$|^@replit\/connectors-sdk$|printavoGateway|\/dropbox$|\/worker$/},a=>({path:a.path,namespace:"mock"}));
  b.onLoad({filter:/.*/,namespace:"mock"},a=>({loader:"js",contents:
    a.path.includes("connectors-sdk")?`export class ReplitConnectors {async proxy(){globalThis.__archive.links++;return {ok:true,json:async()=>({link:"https://content.dropboxapi.com/mock-upload"})};}}`:
    a.path.endsWith("/dropbox")?`export const getDropboxMetadata=(p)=>globalThis.__archive.metadata(p);export const isDropboxPathWithinRoot=(p,r)=>p.startsWith(r+"/");export const listDropboxFolder=()=>{};export const searchDropbox=()=>{};`:
    a.path.endsWith("/worker")?`export const MAX_BYTES=50000000;`:
    a.path.includes("Gateway")?`export const getPrintavoClient=()=>{throw Error("Forbidden live call")};`:
    `export const pool={};`
  }));
}}]});
const {archiveFile,archivePath}=await import("/tmp/sepscope-archive.mjs");
const path=archivePath(folder,"Front OUTPUT.ai","abcdef");
function reset(){
  h={uploaded:false,existing:false,links:0,uploads:0,lookups:[],
    file:{".tag":"file",id:"archive",path_lower:path.toLowerCase(),path_display:path,size:bytes.length,content_hash:hash},
    async metadata(p){
      assert.equal(typeof p,"string","Metadata requests must have a path or ID");
      this.lookups.push(p);
      if(p==="folder")return {path_lower:"/client/#1"};
      if(p==="root")return {path_lower:"/client"};
      assert.equal(p,path);
      if(this.uploaded && this.lookupFails)throw Error("Dropbox returned 503");
      if(this.existing || this.uploaded)return this.file;
      throw Object.assign(Error("path/not_found"),{status:409});
    }};
  globalThis.__archive=h;
  globalThis.fetch=async()=>{h.uploads++;h.uploaded=true;return {ok:true,json:async()=>({"content-hash":h.badResponse?"wrong":hash})};};
}
reset();
assert.equal((await archiveFile(folder,"Front OUTPUT.ai",bytes,"abcdef")).id,"archive");
assert.equal(h.uploads,1);assert.equal(h.lookups.at(-1),path);
reset();h.existing=true;
await archiveFile(folder,"Front OUTPUT.ai",bytes,"abcdef");
assert.equal(h.uploads,0);assert.equal(h.links,0);
for(const change of [{content_hash:"wrong"},{size:0},{path_lower:"/other/file.ai"},{".tag":"folder"}]){
  reset();h.existing=true;Object.assign(h.file,change);
  await assert.rejects(()=>archiveFile(folder,"Front OUTPUT.ai",bytes,"abcdef"),/verification failed/);
  assert.equal(h.uploads,0);
}
reset();h.badResponse=true;
await assert.rejects(()=>archiveFile(folder,"Front OUTPUT.ai",bytes,"abcdef"),/hash not confirmed/);
reset();h.lookupFails=true;
await assert.rejects(()=>archiveFile(folder,"Front OUTPUT.ai",bytes,"abcdef"),/upload accepted.*verification failed/);
assert.equal(h.uploads,1);
console.log("PASS: real temporary-upload response shape, path verification, existing-copy reuse, conflicts, hash mismatch and uncertain verification. All providers mocked.");
