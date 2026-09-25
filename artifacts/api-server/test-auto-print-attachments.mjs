import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const outfile = `${import.meta.dirname}/.auto-print-attachments.test.mjs`;
await build({
  entryPoints: ["tests/autoPrintAttachments.test.ts"],
  absWorkingDir: import.meta.dirname,
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  // Renderer tests exercise the style option only, not browser startup or
  // Printavo access. Avoid loading the live workorder/database dependency.
  plugins: [{
    name: "offline-renderer-dependencies",
    setup(build) {
      build.onResolve({ filter: /\/(?:workorderHtml|browserLaunch|logger)$/ }, (args) => ({
        path: args.path,
        namespace: "offline",
      }));
      build.onLoad({ filter: /.*/, namespace: "offline" }, (args) => ({
        contents: args.path.endsWith("workorderHtml")
          ? "export const isAllowedWorkorderUrl = () => true;"
          : args.path.endsWith("browserLaunch")
            ? "export const closeBrowserBounded = async () => {}; export const launchBrowserWithRecovery = async () => {};"
            : "export const logger = {};",
      }));
    },
  }],
});

const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit" });
process.exit(result.status ?? 1);