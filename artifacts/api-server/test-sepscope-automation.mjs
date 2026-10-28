import { build } from "esbuild";
import { spawnSync } from "node:child_process";
await build({entryPoints:["tests/sepscopeAutomation.test.ts"],absWorkingDir:import.meta.dirname,outfile:"/tmp/sepscope-automation.test.mjs",bundle:true,platform:"node",format:"esm"});
const result=spawnSync(process.execPath,["--test","/tmp/sepscope-automation.test.mjs"],{stdio:"inherit"});
process.exit(result.status??1);
