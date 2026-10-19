import { build } from "esbuild";
import { spawnSync } from "node:child_process";

const outfile = "/tmp/hub-calc-png-only.test.mjs";
const stubs = {
  "@workspace/db": `
    export const hubCalcUploadsTable = { kind: "upload" };
    export const pvOrdersTable = { kind: "order" };
    export const db = {
      select() { return { from(table) { return { where() { return {
        async limit() { return table.kind === "upload" ? [globalThis.calcTest.upload] : [{ visualId: 123, orderType: globalThis.calcTest.orderType }]; }
      }; } }; } }; },
      update() { return { set(patch) { return { where() {
        globalThis.calcTest.patches.push(patch);
        Object.assign(globalThis.calcTest.upload, patch);
        return { async returning() { return [{ id: "upload1" }]; } };
      } }; } }; }
    };
  `,
  "drizzle-orm": "export const and = () => {}; export const eq = () => {}; export const inArray = () => {}; export const isNull = () => {};",
  "../printavoGateway": "export function getPrintavoClient() { return globalThis.calcTest.client; }",
  "./pngStorage": `
    export function hubCalcPngPublicUrl() { return "https://example.test/image.png"; }
    export async function verifyAndConfirmPngUploaded() { return { ok: true }; }
  `,
  "./calcLineItems": `
    export function lineItemSnapshotsEqual(a, b) { return a == null && b == null; }
    export async function pushCalculatorLineItem() { return { requested: false, ok: false }; }
  `,
  "./pushTarget": "export async function resolveConfirmedHandoffQuote() { throw new Error('Unexpected fallback'); }",
};
await build({
  entryPoints: ["tests/hubCalcPngOnly.test.ts"],
  absWorkingDir: import.meta.dirname,
  outfile, bundle: true, platform: "node", format: "esm",
  plugins: [{
    name: "isolated-calculator-infrastructure",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) =>
        Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: "stub" } : undefined);
      b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
    },
  }],
});
const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit" });
process.exit(result.status ?? 1);
