import { useState } from "react";

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: GridIcon },
  { id: "reports", label: "Reports", icon: ChartIcon },
  { id: "print", label: "Print Queue", icon: PrintIcon },
  { id: "purchasing", label: "Purchasing", icon: BoxIcon },
  { id: "ai", label: "Ask AI", icon: SparkleIcon },
  { id: "settings", label: "Settings", icon: GearIcon },
];

const KPI_CARDS = [
  { label: "Total Orders", value: "17,284", sub: "All time", color: "blue" },
  { label: "MTD Revenue", value: "$184,320", sub: "↑ 12% vs last month", color: "green" },
  { label: "Open Orders", value: "342", sub: "Across all statuses", color: "orange" },
  { label: "Items to Order", value: "28", sub: "Needs Ordering flag", color: "red" },
  { label: "Print Jobs Today", value: "14", sub: "9 completed · 5 pending", color: "purple" },
  { label: "Avg Order Value", value: "$1,240", sub: "Last 30 days", color: "teal" },
];

const RECENT_ORDERS = [
  { id: "22177", name: "Summer Camp Tees", customer: "Cam Cook", qty: 72, status: "In Production", statusColor: "#3b82f6", due: "Jul 13" },
  { id: "22165", name: "Corporate Polos", customer: "Acme Corp", qty: 144, status: "Needs Ordering", statusColor: "#f59e0b", due: "Jul 8" },
  { id: "22152", name: "Marathon 5K Shirts", customer: "City Parks Dept", qty: 250, status: "Ready to Print", statusColor: "#10b981", due: "Jul 5" },
  { id: "22140", name: "Embroidered Hats", customer: "Hartwell LLC", qty: 48, status: "Awaiting Approval", statusColor: "#8b5cf6", due: "Jul 15" },
  { id: "22138", name: "School Spirit Week", customer: "Lincoln Elementary", qty: 310, status: "In Production", statusColor: "#3b82f6", due: "Jul 3" },
];

const SYSTEM_STATUS = [
  { label: "Order Cache", value: "17,284 orders", status: "ok", detail: "Refreshed 2h ago" },
  { label: "Enrichment", value: "Tags & pricing", status: "ok", detail: "Full crawl 6h ago" },
  { label: "Auto-Print", value: "Scheduler active", status: "ok", detail: "Next run in 4h" },
  { label: "PO Scan", value: "1,250 invoices", status: "ok", detail: "Refreshed 18m ago" },
];

const PRINT_QUEUE = [
  { id: "22152", name: "Marathon 5K Shirts", type: "Workorder + Packing Slip", printer: "Front Office HP", status: "printed" },
  { id: "22138", name: "School Spirit Week", type: "Workorder", printer: "Production Brother", status: "pending" },
  { id: "22119", name: "Band Merch Drop", type: "Box Labels", printer: "Front Office HP", status: "failed" },
];

export function Dashboard() {
  const [active, setActive] = useState("dashboard");

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 flex flex-col bg-slate-900 border-r border-slate-800 flex-shrink-0">
        {/* Logo */}
        <div className="px-5 py-5 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-blue-500 flex items-center justify-center flex-shrink-0">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="1" y="1" width="5" height="5" rx="1" fill="white" opacity="0.9"/>
                <rect x="8" y="1" width="5" height="5" rx="1" fill="white" opacity="0.6"/>
                <rect x="1" y="8" width="5" height="5" rx="1" fill="white" opacity="0.6"/>
                <rect x="8" y="8" width="5" height="5" rx="1" fill="white" opacity="0.9"/>
              </svg>
            </div>
            <div>
              <div className="text-sm font-semibold text-white leading-none">Printavo Hub</div>
              <div className="text-[10px] text-slate-400 mt-0.5">Mint Print Works</div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActive(id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left ${
                active === id
                  ? "bg-blue-600 text-white"
                  : "text-slate-400 hover:text-slate-100 hover:bg-slate-800"
              }`}
            >
              <Icon size={15} active={active === id} />
              {label}
            </button>
          ))}
        </nav>

        {/* Footer */}
        <div className="px-4 py-4 border-t border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-full bg-slate-700 flex items-center justify-center text-xs font-medium text-slate-300">MP</div>
            <div>
              <div className="text-xs font-medium text-slate-200">Shop Manager</div>
              <div className="text-[10px] text-slate-500">mintprintworks.com</div>
            </div>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-slate-950 border-b border-slate-800 px-8 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-white">Dashboard</h1>
            <p className="text-xs text-slate-500 mt-0.5">Wednesday, June 25, 2026 · Data refreshed 2 hours ago</p>
          </div>
          <div className="flex items-center gap-3">
            <button className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v4m0 0l-2-2m2 2l2-2M1 9h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              Export CSV
            </button>
            <button className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-blue-600 hover:bg-blue-500">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              Force Refresh
            </button>
          </div>
        </div>

        <div className="px-8 py-6 space-y-6">
          {/* KPI Cards */}
          <section>
            <div className="grid grid-cols-6 gap-3">
              {KPI_CARDS.map((k) => (
                <KpiCard key={k.label} {...k} />
              ))}
            </div>
          </section>

          {/* Middle row: Recent Orders + System Status */}
          <div className="grid grid-cols-3 gap-4">
            {/* Recent Orders — takes 2 cols */}
            <section className="col-span-2 bg-slate-900 rounded-xl border border-slate-800">
              <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-white">Recent Orders</h2>
                  <p className="text-xs text-slate-500 mt-0.5">Latest activity across all statuses</p>
                </div>
                <button className="text-xs text-blue-400 hover:text-blue-300 font-medium">View Reports →</button>
              </div>
              <div className="divide-y divide-slate-800">
                {RECENT_ORDERS.map((o) => (
                  <div key={o.id} className="px-5 py-3 flex items-center gap-4 hover:bg-slate-800/50 transition-colors">
                    <div className="w-14 flex-shrink-0">
                      <span className="text-xs font-mono text-slate-400">#{o.id}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-slate-100 truncate">{o.name}</div>
                      <div className="text-[11px] text-slate-500">{o.customer} · {o.qty} pcs</div>
                    </div>
                    <div className="flex-shrink-0">
                      <span
                        className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium"
                        style={{ background: o.statusColor + "22", color: o.statusColor }}
                      >
                        {o.status}
                      </span>
                    </div>
                    <div className="w-14 text-right flex-shrink-0">
                      <span className="text-[11px] text-slate-400">Due {o.due}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* System Status */}
            <section className="bg-slate-900 rounded-xl border border-slate-800">
              <div className="px-5 py-4 border-b border-slate-800">
                <h2 className="text-sm font-semibold text-white">System Status</h2>
                <p className="text-xs text-slate-500 mt-0.5">Shared data pipeline health</p>
              </div>
              <div className="px-5 py-3 space-y-3">
                {SYSTEM_STATUS.map((s) => (
                  <div key={s.label} className="flex items-start gap-3">
                    <div className="w-2 h-2 rounded-full bg-emerald-400 mt-1 flex-shrink-0" />
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-slate-200">{s.label}</span>
                        <span className="text-[10px] text-emerald-400 font-medium">OK</span>
                      </div>
                      <div className="text-[11px] text-slate-400">{s.value}</div>
                      <div className="text-[10px] text-slate-600 mt-0.5">{s.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
              {/* Rate limit note */}
              <div className="mx-5 mb-4 mt-1 px-3 py-2.5 bg-blue-950/50 border border-blue-800/40 rounded-lg">
                <div className="text-[10px] text-blue-400 font-medium mb-1">Shared Rate Limit</div>
                <div className="text-[10px] text-blue-300/70 leading-relaxed">All Printavo calls flow through one queue — 550ms between pages, across all modules.</div>
              </div>
            </section>
          </div>

          {/* Bottom row: Print Queue + Quick Actions */}
          <div className="grid grid-cols-3 gap-4">
            {/* Recent Print Jobs */}
            <section className="col-span-2 bg-slate-900 rounded-xl border border-slate-800">
              <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-white">Recent Print Jobs</h2>
                  <p className="text-xs text-slate-500 mt-0.5">Auto-print engine activity</p>
                </div>
                <button className="text-xs text-blue-400 hover:text-blue-300 font-medium">Print Queue →</button>
              </div>
              <div className="divide-y divide-slate-800">
                {PRINT_QUEUE.map((j) => (
                  <div key={j.id} className="px-5 py-3 flex items-center gap-4 hover:bg-slate-800/50 transition-colors">
                    <div className="w-14 flex-shrink-0">
                      <span className="text-xs font-mono text-slate-400">#{j.id}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-slate-100 truncate">{j.name}</div>
                      <div className="text-[11px] text-slate-500">{j.type} · {j.printer}</div>
                    </div>
                    <StatusBadge status={j.status} />
                  </div>
                ))}
              </div>
            </section>

            {/* Quick Actions */}
            <section className="bg-slate-900 rounded-xl border border-slate-800">
              <div className="px-5 py-4 border-b border-slate-800">
                <h2 className="text-sm font-semibold text-white">Quick Actions</h2>
                <p className="text-xs text-slate-500 mt-0.5">Jump to common tasks</p>
              </div>
              <div className="p-4 space-y-2">
                <QuickAction label="Print Workorders" sub="Manual order selection" color="blue" />
                <QuickAction label="Build a PO" sub="28 items need ordering" color="amber" badge="28" />
                <QuickAction label="Ask AI" sub="Natural language search" color="violet" />
                <QuickAction label="Schedule Report" sub="Email delivery setup" color="emerald" />
                <QuickAction label="Auto-Print Config" sub="Printer & status routing" color="slate" />
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const COLOR_MAP: Record<string, { bg: string; text: string; border: string }> = {
  blue:   { bg: "bg-blue-950/40",   text: "text-blue-400",   border: "border-blue-800/40" },
  green:  { bg: "bg-emerald-950/40",text: "text-emerald-400",border: "border-emerald-800/40" },
  orange: { bg: "bg-orange-950/40", text: "text-orange-400", border: "border-orange-800/40" },
  red:    { bg: "bg-red-950/40",    text: "text-red-400",    border: "border-red-800/40" },
  purple: { bg: "bg-violet-950/40", text: "text-violet-400", border: "border-violet-800/40" },
  teal:   { bg: "bg-teal-950/40",   text: "text-teal-400",   border: "border-teal-800/40" },
};

function KpiCard({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  const c = COLOR_MAP[color] ?? COLOR_MAP.blue;
  return (
    <div className={`rounded-xl border p-4 ${c.bg} ${c.border}`}>
      <div className={`text-[10px] font-medium uppercase tracking-wide ${c.text} mb-2`}>{label}</div>
      <div className="text-xl font-bold text-white leading-none">{value}</div>
      <div className="text-[10px] text-slate-500 mt-1.5">{sub}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    printed: "bg-emerald-900/50 text-emerald-400",
    pending: "bg-yellow-900/50 text-yellow-400",
    failed:  "bg-red-900/50 text-red-400",
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${map[status] ?? "bg-slate-700 text-slate-300"}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

const ACTION_COLORS: Record<string, string> = {
  blue:   "bg-blue-600 hover:bg-blue-500",
  amber:  "bg-amber-600 hover:bg-amber-500",
  violet: "bg-violet-600 hover:bg-violet-500",
  emerald:"bg-emerald-600 hover:bg-emerald-500",
  slate:  "bg-slate-700 hover:bg-slate-600",
};

function QuickAction({ label, sub, color, badge }: { label: string; sub: string; color: string; badge?: string }) {
  return (
    <button className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-left transition-colors ${ACTION_COLORS[color]}`}>
      <div>
        <div className="text-xs font-semibold text-white">{label}</div>
        <div className="text-[10px] text-white/60 mt-0.5">{sub}</div>
      </div>
      {badge && (
        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-white/20 text-white text-[10px] font-bold flex items-center justify-center">{badge}</span>
      )}
    </button>
  );
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function GridIcon({ size = 16, active }: { size?: number; active?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="1" y="1" width="6" height="6" rx="1.5" fill={active ? "white" : "currentColor"} opacity={active ? 1 : 0.7}/>
      <rect x="9" y="1" width="6" height="6" rx="1.5" fill={active ? "white" : "currentColor"} opacity={active ? 0.7 : 0.4}/>
      <rect x="1" y="9" width="6" height="6" rx="1.5" fill={active ? "white" : "currentColor"} opacity={active ? 0.7 : 0.4}/>
      <rect x="9" y="9" width="6" height="6" rx="1.5" fill={active ? "white" : "currentColor"} opacity={active ? 1 : 0.7}/>
    </svg>
  );
}

function ChartIcon({ size = 16 }: { size?: number; active?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="1" y="9" width="3" height="6" rx="1" fill="currentColor" opacity="0.7"/>
      <rect x="6" y="5" width="3" height="10" rx="1" fill="currentColor" opacity="0.7"/>
      <rect x="11" y="2" width="3" height="13" rx="1" fill="currentColor" opacity="0.7"/>
    </svg>
  );
}

function PrintIcon({ size = 16 }: { size?: number; active?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="3" y="1" width="10" height="5" rx="1" fill="currentColor" opacity="0.5"/>
      <rect x="1" y="5" width="14" height="7" rx="1.5" fill="currentColor" opacity="0.7"/>
      <rect x="3" y="10" width="10" height="5" rx="1" fill="currentColor" opacity="0.5"/>
      <rect x="10" y="7.5" width="2" height="2" rx="0.5" fill="currentColor" opacity="1"/>
    </svg>
  );
}

function BoxIcon({ size = 16 }: { size?: number; active?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M8 1.5L14 4.5V11.5L8 14.5L2 11.5V4.5L8 1.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" opacity="0.7"/>
      <path d="M8 1.5V14.5M2 4.5L8 7.5L14 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.7"/>
    </svg>
  );
}

function SparkleIcon({ size = 16 }: { size?: number; active?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M8 1l1.5 4.5L14 7l-4.5 1.5L8 13l-1.5-4.5L2 7l4.5-1.5L8 1z" fill="currentColor" opacity="0.7"/>
    </svg>
  );
}

function GearIcon({ size = 16 }: { size?: number; active?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.4" opacity="0.7"/>
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.7"/>
    </svg>
  );
}
