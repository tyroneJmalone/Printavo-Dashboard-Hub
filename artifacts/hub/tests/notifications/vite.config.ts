// Separate test server: never imported by the Hub's production build.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const here = import.meta.dirname;
export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss({ optimize: false })],
  resolve: {
    alias: [
      { find: "@/components/auth/StaffGate", replacement: path.join(here, "identity.ts") },
      { find: "@clerk/react", replacement: path.join(here, "identity.ts") },
      { find: "@", replacement: path.resolve(here, "../../src") },
      { find: "@assets", replacement: path.resolve(here, "../../../../attached_assets") },
    ],
    dedupe: ["react", "react-dom"],
  },
  server: { host: "0.0.0.0", port: 5180, strictPort: true, allowedHosts: true },
});
