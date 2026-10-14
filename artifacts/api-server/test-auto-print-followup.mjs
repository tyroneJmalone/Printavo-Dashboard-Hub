import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
const root=import.meta.dirname;
const outfile="/tmp/autoprint-followup-test.mjs";
try {
  await build({
    entryPoints:["tests/autoPrintFollowup.test.ts"],absWorkingDir:root,
    outfile,bundle:true,platform:"node",format:"esm",
    banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"},
    plugins:[{name:"offline-followup-boundaries",setup(b){
      b.onResolve({filter:/@workspace\/db$/},()=>({path:"db",namespace:"fixture"}));
      b.onLoad({filter:/.*/,namespace:"fixture"},()=>({
        contents:`export * from ${JSON.stringify(path.resolve(root,"../../lib/db/src/schema/index.ts"))}; export { db,pool } from ${JSON.stringify(path.join(root,"tests/autoPrintFollowupFixture.ts"))};`,
        loader:"ts",resolveDir:root,
      }));
      b.onResolve({filter:/(?:\/config|printavoGateway|liveDiscovery|chipply\/categoryReview|\/statusJobs)$/},args=>
        args.importer.endsWith("/autoPrint/followup.ts")?{path:path.join(root,"tests/autoPrintFollowupFixture.ts")}:undefined);
      b.onResolve({filter:/(?:\/pdf|\/printNode|\/engine|\/retryWorker)$/},()=>{throw Error("Forbidden printer/engine dependency in correction path");});
    }}],
  });
  process.exitCode=spawnSync(process.execPath,["--test",outfile],{stdio:"inherit",env:{...process.env,DATABASE_URL:"postgresql://unused:unused@127.0.0.1:1/unused"}}).status??1;
}finally{rmSync(outfile,{force:true});}
