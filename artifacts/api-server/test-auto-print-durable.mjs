import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const dbRequire = createRequire(path.resolve(import.meta.dirname, "../../lib/db/package.json"));
const dir = path.join(import.meta.dirname, ".durable-test");
mkdirSync(dir, { recursive: true });
try {
  await build({ entryPoints: ["tests/autoPrintDurable.test.ts"], absWorkingDir: import.meta.dirname,
    outfile: `${dir}/test.mjs`, bundle: true, platform: "node", format: "esm",
    banner: { js: `import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);` },
    packages: "external", alias: {
      "@workspace/db": path.resolve(import.meta.dirname, "../../lib/db/src/index.ts"),
      "@workspace/printavo": path.resolve(import.meta.dirname, "../../lib/printavo/src/index.ts"),
    },
    plugins: [{ name: "no-live-side-effects", setup(build) {
      build.onResolve({ filter: /^(pg|drizzle-zod)$/ }, args => ({ path: dbRequire.resolve(args.path), external: true }));
      build.onResolve({ filter: /(?:printavoGateway|\/pdf|\/printNode|\/statusJobs|\/hubPoBatch|\/purchaseNotes|\/chipply\/categoryReview)$/ }, args => ({ path: args.path, namespace: "blocked" }));
      build.onLoad({ filter: /.*/, namespace: "blocked" }, () => ({
        contents: `const blocked=()=>{throw new Error("LIVE SIDE EFFECT BLOCKED IN TEST")};
        export const getPrintavoClient=blocked,openPdfRenderer=blocked,submitPdfPrintJob=blocked,printNodeConfigured=()=>false,startPqStatusJob=blocked,runHubPoBatch=blocked,loadPurchaseNotes=blocked,liveCategories=blocked,previewReview=blocked,commitReview=blocked;`,
      }));
    }}],
  });
  const result = spawnSync(process.execPath, ["--test", `${dir}/test.mjs`], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally { rmSync(dir, { recursive: true, force: true }); }
