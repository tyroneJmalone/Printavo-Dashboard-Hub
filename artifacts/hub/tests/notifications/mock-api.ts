import { jobs, notifications, run } from "./fixtures";

export const requests: { path: string; method: string; admin: string }[] = [];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json" },
});

// Fail closed: NO request handled here ever delegates to real fetch.
window.fetch = async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
  const method = options?.method ?? (input instanceof Request ? input.method : "GET");
  const admin = localStorage.getItem("test-admin") ?? "admin-a";
  const role = localStorage.getItem("test-role") ?? "admin";
  requests.push({ path: url.pathname + url.search, method, admin });
  const reads = new Set<string>(JSON.parse(localStorage.getItem(`test-reads-${admin}`) ?? "[]"));
  const base = "/api/print-queue/auto-print/notifications";
  if (url.pathname.startsWith(base)) {
    if (role !== "admin") return json({ error: "Admin only" }, 403);
    if (method === "GET" && url.pathname === base) {
      if (localStorage.getItem("test-list-error")) return json({ error: "Mock notification service unavailable" }, 503);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return json({
        items: notifications.slice(offset, offset + 30).map(n => ({ ...n, read: reads.has(n.id) })),
        total: notifications.length, unread: notifications.filter(n => !reads.has(n.id)).length,
      });
    }
    const match = url.pathname.match(/\/notifications\/(alert-\d+)\/read$/);
    if (method === "POST" && match) {
      if (localStorage.getItem("test-read-error")) return json({ error: "Mock mark-read failure" }, 503);
      reads.add(match[1]);
      localStorage.setItem(`test-reads-${admin}`, JSON.stringify([...reads]));
      return json({ ok: true });
    }
  }
  if (method !== "GET") return json({ error: `Blocked test mutation: ${method} ${url.pathname}` }, 403);
  const path = url.pathname;
  if (path.endsWith("/autoprint/runs")) return json({ runs: [run] });
  if (path.endsWith("/autoprint/runs/run-older")) return json({ ...run, id: "run-older", error: "Mock older linked run" });
  if (path.endsWith("/autoprint/runs/run-recent")) return json(run);
  if (path.endsWith("/autoprint/retries")) return json({ jobs });
  if (path.endsWith("/autoprint/jobs")) return json({ jobs: [], total: 0 });
  if (path.endsWith("/autoprint/config")) return json(null); // Settings editor is outside this test.
  if (path === "/api/sync/status") return json({});
  if (path === "/api/purchasing/needs-ordering") return json({ count: 0, orders: [] });
  return json({ error: `Unmocked request blocked: ${method} ${path}` }, 501);
};
Object.assign(window, { notificationTest: { requests } });
