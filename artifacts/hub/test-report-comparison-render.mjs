import { createRequire } from "node:module";
// Reuse the workspace API test bundler rather than adding a frontend runtime dependency.
const { build } = createRequire(new URL("../api-server/package.json", import.meta.url))("esbuild");
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
const output = path.join(import.meta.dirname, ".comparison-render-test.cjs");
try {
  await build({
    stdin: { sourcefile: "comparison-render.tsx", resolveDir: import.meta.dirname, loader: "tsx", contents: `
      import assert from "node:assert/strict";
      import { renderToStaticMarkup } from "react-dom/server";
      import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
      import { SummaryComparison, BreakdownComparison } from "./src/components/ReportComparison";
      import { getGetOrdersReportQueryKey, getGetStatusBreakdownQueryKey } from "@workspace/api-client-react";
      const props = {
        currentParams: {orderType:"invoice", statuses:"PRINT", createdStart:"2026-10-01", createdEnd:"2026-10-13"},
        previousParams: {orderType:"invoice", statuses:"PRINT", createdStart:"2025-10-01", createdEnd:"2025-10-13"},
        currentRange: {start:"2026-10-01",end:"2026-10-13"},
        previousRange: {start:"2025-10-01",end:"2025-10-13"}
      };
      const row = (label, orders, revenue) => ({label,orders,revenue,quantity:orders*10});
      const current = {stats:{orders:4,revenue:200,quantity:40}, rows:[row("New method",2,100),row("Shared method",2,100)]};
      const previous = {stats:{orders:2,revenue:100,quantity:20}, rows:[row("Old method",1,50),row("Shared method",1,50)]};
      const client = new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,gcTime:Infinity}}});
      const render = node => renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
      let html = render(<SummaryComparison {...props}/>);
      assert.match(html,/Loading comparison/);
      client.setQueryData(getGetOrdersReportQueryKey({...props.currentParams,limit:1,offset:0}),current);
      client.setQueryData(getGetOrdersReportQueryKey({...props.previousParams,limit:1,offset:0}),previous);
      html = render(<SummaryComparison {...props}/>);
      assert.match(html,/100.0%/);
      assert.match(html,/2025-10-01/);
      client.setQueryData(getGetStatusBreakdownQueryKey(props.currentParams),current);
      client.setQueryData(getGetStatusBreakdownQueryKey(props.previousParams),previous);
      html = render(<BreakdownComparison tab="status" {...props}/>);
      for (const text of ["New method","Old method","Shared method","New activity","No activity this period","No prior-year baseline","Full filtered totals","percentage points"]) assert.ok(html.includes(text),text);
      assert.match(html,/50.0% \\/ 0.0%/);
      assert.match(html,/50.0 pp/);
      // A different filter set must not accidentally show the cached old results.
      html = render(<BreakdownComparison tab="status" {...props} previousParams={{...props.previousParams,brands:"unfetched brand"}}/>);
      assert.match(html,/Loading comparison/);
      assert.ok(!html.includes("New method"));
      client.setQueryData(getGetStatusBreakdownQueryKey(props.currentParams),{stats:{orders:0,quantity:0,revenue:0},rows:[]});
      client.setQueryData(getGetStatusBreakdownQueryKey(props.previousParams),{stats:{orders:0,quantity:0,revenue:0},rows:[]});
      html = render(<BreakdownComparison tab="status" {...props}/>);
      assert.match(html,/No groups found in either period/);
      const failed = client.getQueryCache().find({queryKey:getGetStatusBreakdownQueryKey(props.previousParams)});
      failed.setState({status:"error",error:new Error("test failure")});
      html = render(<BreakdownComparison tab="status" {...props}/>);
      assert.match(html,/Comparison could not load/);
      client.clear();
      console.log("PASS rendered comparison: summary, union, totals, shares, missing baseline, loading, empty, errors and filter isolation");
    `},
    outfile: output, bundle: true, platform: "node", format: "cjs", jsx: "automatic",
    external: ["react", "react-dom/server", "@tanstack/react-query", "lucide-react"],
    alias: { "@": path.join(import.meta.dirname, "src") },
  });
  process.exitCode = spawnSync(process.execPath, [output], { stdio: "inherit" }).status ?? 1;
} finally { rmSync(output, { force: true }); }
