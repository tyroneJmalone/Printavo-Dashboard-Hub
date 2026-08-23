import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const outfile = "/tmp/hub-calc.test.mjs";

await build({
  entryPoints: ["tests/hubCalc.test.ts"],
  absWorkingDir: import.meta.dirname,
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: "inline",
  plugins: [
    {
      name: "stub-infra",
      setup(b) {
        // Stub @workspace/db — pure helpers and calcPush helpers don't call it
        b.onResolve({ filter: /^@workspace\/db$/ }, () => ({
          path: "@workspace/db",
          namespace: "stub-db",
        }));
        b.onLoad({ filter: /.*/, namespace: "stub-db" }, () => ({
          contents: `
export const db = null;
export const hubCalcUploadsTable = {};
export const pvOrdersTable = {};
`,
          loader: "js",
        }));

        // Stub @workspace/integrations-openai-ai-server
        b.onResolve({ filter: /^@workspace\/integrations-openai-ai-server$/ }, () => ({
          path: "oai-stub",
          namespace: "stub-oai",
        }));
        b.onLoad({ filter: /.*/, namespace: "stub-oai" }, () => ({
          contents: "export const openai = null;",
          loader: "js",
        }));

        // Stub the objectStorage module (requires GCS credentials)
        b.onResolve({ filter: /\/objectStorage$/ }, () => ({
          path: "obj-stub",
          namespace: "stub-obj",
        }));
        b.onLoad({ filter: /.*/, namespace: "stub-obj" }, () => ({
          contents: `
export const objectStorageClient = null;
export function getPrivateObjectDir() { return '/test-bucket'; }
export function parseObjectPath(p) {
  const parts = p.replace(/^\\//, '').split('/');
  return { bucketName: parts[0] ?? 'bucket', objectName: parts.slice(1).join('/') };
}
`,
          loader: "js",
        }));

        // Stub the publicUrl module
        b.onResolve({ filter: /\/publicUrl$/ }, () => ({
          path: "url-stub",
          namespace: "stub-url",
        }));
        b.onLoad({ filter: /.*/, namespace: "stub-url" }, () => ({
          contents: "export function publicBaseUrl() { return 'https://test.example.com'; }",
          loader: "js",
        }));

        // Stub printavoGateway
        b.onResolve({ filter: /\/printavoGateway$/ }, () => ({
          path: "gw-stub",
          namespace: "stub-gw",
        }));
        b.onLoad({ filter: /.*/, namespace: "stub-gw" }, () => ({
          contents: "export function getPrintavoClient() { throw new Error('no Printavo in tests'); }",
          loader: "js",
        }));

        // Stub drizzle-orm (used in calcPush/pngStorage via @workspace/db)
        b.onResolve({ filter: /^drizzle-orm/ }, () => ({
          path: "drizzle-stub",
          namespace: "stub-drizzle",
        }));
        b.onLoad({ filter: /.*/, namespace: "stub-drizzle" }, () => ({
          contents: `
export const eq = () => {};
export const and = () => {};
export const isNull = () => {};
export const sql = (s) => s;
`,
          loader: "js",
        }));
      },
    },
  ],
});

const result = spawnSync(
  process.execPath,
  ["--enable-source-maps", "--test", outfile],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
