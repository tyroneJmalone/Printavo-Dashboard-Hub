import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const docsDir = fileURLToPath(new URL("../../docs/", import.meta.url));

// Package only explicitly curated files inside the server bundle. No public
// static directory and no user-supplied filesystem paths.
export function adminDocumentsPlugin() {
  return {
    name: "admin-planning-documents",
    setup(build) {
      build.onResolve({ filter: /^hub-planning-documents$/ }, () => ({
        path: "hub-planning-documents", namespace: "admin-documents",
      }));
      build.onLoad({ filter: /.*/, namespace: "admin-documents" }, async () => {
        const manifest = JSON.parse(await readFile(path.join(docsDir, "admin-planning-index.json"), "utf8"));
        const ids = new Set();
        const documents = await Promise.all(manifest.map(async (entry) => {
          if (!/^[a-z0-9-]+\.md$/.test(entry.filename) || ids.has(entry.id)) {
            throw new Error("Invalid or duplicate admin document entry");
          }
          ids.add(entry.id);
          const content = await readFile(path.join(docsDir, entry.filename), "utf8");
          return { ...entry, content };
        }));
        return { contents: `export default ${JSON.stringify(documents)};`, loader: "js" };
      });
    },
  };
}
