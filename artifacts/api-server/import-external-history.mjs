// Explicit development-only import. Never runs on server start or during publishing.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
if (process.env.REPLIT_DEPLOYMENT === "1") throw new Error("Use the authenticated import UI in production");
const outfile = "/tmp/import-external-history.mjs";
try {
  await build({
    stdin: {resolveDir: import.meta.dirname, contents: `
      import { importExternalVendorOrders, listExternalVendorOrders } from "./src/lib/purchasing/externalVendorTracking";
      const result = await importExternalVendorOrders();
      const rows = await listExternalVendorOrders();
      console.log(JSON.stringify({result, total:rows.length, vendors: rows.reduce((counts,r)=>({...counts,[r.vendor]:(counts[r.vendor]||0)+1}),{})}));
      process.exit(result.errors.length ? 1 : 0);
    `, loader: "ts"},
    outfile, bundle:true, platform:"node", format:"esm",
    external:["sharp","pg-native"],
    banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"},
  });
  const result = spawnSync(process.execPath,[outfile],{stdio:"inherit",env:{...process.env,NODE_ENV:"production"}});
  process.exitCode = result.status ?? 1;
} finally { rmSync(outfile,{force:true}); }
