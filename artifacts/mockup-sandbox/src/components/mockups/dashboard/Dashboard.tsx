import { useState, type JSX } from "react";

// ─── Nav (grouped) ──────────────────────────────────────────────────────────
const NAV_GROUPS: { heading: string | null; items: { id: string; label: string; icon: (p: IconProps) => JSX.Element; badge?: string }[] }[] = [
  {
    heading: null,
    items: [{ id: "dashboard", label: "Dashboard", icon: GridIcon }],
  },
  {
    heading: "Analyze",
    items: [
      { id: "reports", label: "Reports", icon: ChartIcon },
      { id: "ai", label: "Ask AI", icon: SparkleIcon },
    ],
  },
  {
    heading: "Sales",
    items: [{ id: "reorders", label: "Reorder Inbox", icon: InboxIcon, badge: "7" }],
  },
  {
    heading: "Purchasing",
    items: [
      { id: "reorder", label: "Reorder Scan", icon: ScanIcon, badge: "28" },
      { id: "vendor", label: "Vendor Orders", icon: TruckIcon, badge: "12" },
    ],
  },
  {
    heading: "Production",
    items: [
      { id: "print", label: "Print Queue", icon: PrintIcon },
      { id: "colors", label: "Color Library", icon: PaletteIcon },
    ],
  },
  {
    heading: "Quoting",
    items: [{ id: "quote", label: "Price Calculator", icon: CalcIcon }],
  },
  {
    heading: "Shipping",
    items: [
      { id: "rates", label: "Rate Estimator", icon: BoxIcon },
      { id: "sorter", label: "Label Sorter", icon: PagesIcon },
    ],
  },
  {
    heading: "Data",
    items: [{ id: "backups", label: "Backups", icon: ShieldIcon }],
  },
];

const KPI_CARDS = [
  { label: "Total Orders", value: "17,284", sub: "All time", color: "blue" },
  { label: "MTD Revenue", value: "$184,320", sub: "↑ 12% vs last month", color: "green" },
  { label: "Open Orders", value: "342", sub: "Across all statuses", color: "orange" },
  { label: "Items to Reorder", value: "28", sub: "Needs Ordering flag", color: "red" },
  { label: "Open Vendor POs", value: "12", sub: "3 in transit", color: "purple" },
  { label: "Reorder Requests", value: "7", sub: "New from portal", color: "teal" },
];

const MODULES = [
  { id: "reports", title: "Reports", desc: "Analytics & exports", stat: "17,284 cached", color: "#3b82f6", icon: ChartIcon },
  { id: "reorders", title: "Reorder Inbox", desc: "Customer portal", stat: "7 new this week", color: "#14b8a6", icon: InboxIcon },
  { id: "reorder", title: "Reorder Scan", desc: "Items to order", stat: "28 flagged", color: "#ef4444", icon: ScanIcon },
  { id: "vendor", title: "Vendor Orders", desc: "SanMar & S&S", stat: "12 open · 3 shipping", color: "#8b5cf6", icon: TruckIcon },
  { id: "quote", title: "Price Calculator", desc: "Decoration quoting", stat: "14 matrices", color: "#f59e0b", icon: CalcIcon },
  { id: "rates", title: "Rate Estimator", desc: "USPS & UPS", stat: "ShipStation + EasyPost", color: "#10b981", icon: BoxIcon },
  { id: "sorter", title: "Label Sorter", desc: "Slip + label match", stat: "PDF sort", color: "#ec4899", icon: PagesIcon },
  { id: "print", title: "Print Queue", desc: "Workorders + auto", stat: "5 pending", color: "#06b6d4", icon: PrintIcon },
  { id: "colors", title: "Color Library", desc: "Pantone · thread · ink", stat: "6,199 colors", color: "#a855f7", icon: PaletteIcon },
  { id: "backups", title: "Backups", desc: "Account archive", stat: "Last run 2h ago", color: "#64748b", icon: ShieldIcon },
];

const RECENT_ORDERS = [
  { id: "22177", name: "Summer Camp Tees", customer: "Cam Cook", qty: 72, status: "In Production", statusColor: "#3b82f6", due: "Jul 13" },
  { id: "22165", name: "Corporate Polos", customer: "Acme Corp", qty: 144, status: "Needs Ordering", statusColor: "#f59e0b", due: "Jul 8" },
  { id: "22152", name: "Marathon 5K Shirts", customer: "City Parks Dept", qty: 250, status: "Ready to Print", statusColor: "#10b981", due: "Jul 5" },
  { id: "22140", name: "Embroidered Hats", customer: "Hartwell LLC", qty: 48, status: "Awaiting Approval", statusColor: "#8b5cf6", due: "Jul 15" },
];

const PIPELINE = [
  { label: "Reorder Scan", value: "28 items flagged", detail: "PO scan 18m ago" },
  { label: "Vendor Sync", value: "12 POs · 3 tracking", detail: "SanMar + S&S polled 25m ago" },
  { label: "Auto-Print", value: "Scheduler active", detail: "Next run in 4h" },
  { label: "Account Backup", value: "Full · Dropbox", detail: "Completed 2h ago" },
  { label: "Reorder Portal", value: "Live · public", detail: "7 requests this week" },
];

const VENDOR_ORDERS = [
  { po: "PO-4821", vendor: "SanMar", items: "PC61 · 4 colors", status: "shipped", track: "1Z99A...", color: "#8b5cf6" },
  { po: "PO-4818", vendor: "S&S", items: "5000 · Black/White", status: "submitted", track: "—", color: "#06b6d4" },
  { po: "PO-4815", vendor: "SanMar", items: "DT6000 · Navy", status: "error", track: "—", color: "#8b5cf6" },
];

const REORDER_INBOX = [
  { customer: "Lincoln Elementary", order: "1042", items: "Spirit Week Tees", qty: 120, when: "2h ago", status: "new" },
  { customer: "Acme Corp", order: "0991", items: "Corporate Polos — restock", qty: 48, when: "5h ago", status: "new" },
  { customer: "Hartwell LLC", order: "1018", items: "Embroidered Caps", qty: 24, when: "Yesterday", status: "reviewed" },
  { customer: "City Parks Dept", order: "1003", items: "Marathon 5K Shirts", qty: 200, when: "Yesterday", status: "quoted" },
];

export function Dashboard() {
  const [active, setActive] = useState("dashboard");

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-60 flex flex-col bg-slate-900 border-r border-slate-800 flex-shrink-0">
        <div className="px-5 py-5 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-blue-500 flex items-center justify-center flex-shrink-0">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="1" y="1" width="5" height="5" rx="1" fill="white" opacity="0.9" />
                <rect x="8" y="1" width="5" height="5" rx="1" fill="white" opacity="0.6" />
                <rect x="1" y="8" width="5" height="5" rx="1" fill="white" opacity="0.6" />
                <rect x="8" y="8" width="5" height="5" rx="1" fill="white" opacity="0.9" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-semibold text-white leading-none">Printavo Hub</div>
              <div className="text-[10px] text-slate-400 mt-0.5">Mint Printworks</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-3 py-3 space-y-3 overflow-y-auto">
          {NAV_GROUPS.map((group, gi) => (
            <div key={gi}>
              {group.heading && (
                <div className="px-3 mb-1 text-[9px] font-semibold uppercase tracking-wider text-slate-600">{group.heading}</div>
              )}
              <div className="space-y-0.5">
                {group.items.map(({ id, label, icon: Icon, badge }) => (
                  <button
                    key={id}
                    onClick={() => setActive(id)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors text-left ${
                      active === id ? "bg-blue-600 text-white" : "text-slate-400 hover:text-slate-100 hover:bg-slate-800"
                    }`}
                  >
                    <Icon size={15} active={active === id} />
                    <span className="flex-1">{label}</span>
                    {badge && (
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${active === id ? "bg-white/20 text-white" : "bg-slate-800 text-slate-400"}`}>{badge}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="px-3 py-2 border-t border-slate-800">
          <button
            onClick={() => setActive("settings")}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors text-left ${
              active === "settings" ? "bg-blue-600 text-white" : "text-slate-400 hover:text-slate-100 hover:bg-slate-800"
            }`}
          >
            <GearIcon size={15} active={active === "settings"} />
            Settings
          </button>
        </div>

        <div className="px-4 py-3 border-t border-slate-800">
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
        <div className="sticky top-0 z-10 bg-slate-950 border-b border-slate-800 px-8 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-white">Dashboard</h1>
            <p className="text-xs text-slate-500 mt-0.5">Friday, June 26, 2026 · Data refreshed 2 hours ago</p>
          </div>
          <div className="flex items-center gap-3">
            <button className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v4m0 0l-2-2m2 2l2-2M1 9h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              Export CSV
            </button>
            <button className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-blue-600 hover:bg-blue-500">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
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

          {/* Module grid */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-white">Your Tools</h2>
              <span className="text-[11px] text-slate-500">10 modules · one shared Printavo connection</span>
            </div>
            <div className="grid grid-cols-5 gap-3">
              {MODULES.map((m) => (
                <ModuleCard key={m.id} {...m} />
              ))}
            </div>
          </section>

          {/* Recent Orders + Pipeline status */}
          <div className="grid grid-cols-3 gap-4">
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
                    <div className="w-14 flex-shrink-0"><span className="text-xs font-mono text-slate-400">#{o.id}</span></div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-slate-100 truncate">{o.name}</div>
                      <div className="text-[11px] text-slate-500">{o.customer} · {o.qty} pcs</div>
                    </div>
                    <div className="flex-shrink-0">
                      <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium" style={{ background: o.statusColor + "22", color: o.statusColor }}>{o.status}</span>
                    </div>
                    <div className="w-14 text-right flex-shrink-0"><span className="text-[11px] text-slate-400">Due {o.due}</span></div>
                  </div>
                ))}
              </div>
            </section>

            <section className="bg-slate-900 rounded-xl border border-slate-800">
              <div className="px-5 py-4 border-b border-slate-800">
                <h2 className="text-sm font-semibold text-white">Pipeline Status</h2>
                <p className="text-xs text-slate-500 mt-0.5">Shared background jobs</p>
              </div>
              <div className="px-5 py-3 space-y-2.5">
                {PIPELINE.map((s) => (
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
              <div className="mx-5 mb-4 mt-1 px-3 py-2.5 bg-blue-950/50 border border-blue-800/40 rounded-lg">
                <div className="text-[10px] text-blue-400 font-medium mb-1">Shared Rate Limit</div>
                <div className="text-[10px] text-blue-300/70 leading-relaxed">Every Printavo call — reports, reorder scan, vendor sync, backup, portal — flows through one queue (10 req / 5 sec).</div>
              </div>
            </section>
          </div>

          {/* Vendor orders + Quick actions */}
          <div className="grid grid-cols-3 gap-4">
            <section className="col-span-2 bg-slate-900 rounded-xl border border-slate-800">
              <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-white">Vendor Orders</h2>
                  <p className="text-xs text-slate-500 mt-0.5">SanMar & S&S submission status</p>
                </div>
                <button className="text-xs text-blue-400 hover:text-blue-300 font-medium">All Vendor Orders →</button>
              </div>
              <div className="divide-y divide-slate-800">
                {VENDOR_ORDERS.map((v) => (
                  <div key={v.po} className="px-5 py-3 flex items-center gap-4 hover:bg-slate-800/50 transition-colors">
                    <div className="w-16 flex-shrink-0"><span className="text-xs font-mono text-slate-400">{v.po}</span></div>
                    <div className="flex-shrink-0 w-16">
                      <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium" style={{ background: v.color + "22", color: v.color }}>{v.vendor}</span>
                    </div>
                    <div className="flex-1 min-w-0"><div className="text-xs text-slate-300 truncate">{v.items}</div></div>
                    <div className="w-20 flex-shrink-0"><span className="text-[11px] font-mono text-slate-500">{v.track}</span></div>
                    <StatusBadge status={v.status} />
                  </div>
                ))}
              </div>
            </section>

            <section className="bg-slate-900 rounded-xl border border-slate-800">
              <div className="px-5 py-4 border-b border-slate-800">
                <h2 className="text-sm font-semibold text-white">Quick Actions</h2>
                <p className="text-xs text-slate-500 mt-0.5">Jump to common tasks</p>
              </div>
              <div className="p-4 grid grid-cols-2 gap-2">
                <QuickAction label="New Quote" color="amber" icon={CalcIcon} />
                <QuickAction label="Build PO" color="rose" icon={ScanIcon} badge="28" />
                <QuickAction label="Submit Order" color="violet" icon={TruckIcon} />
                <QuickAction label="Print" color="cyan" icon={PrintIcon} />
                <QuickAction label="Get Rates" color="emerald" icon={BoxIcon} />
                <QuickAction label="Sort Labels" color="pink" icon={PagesIcon} />
                <QuickAction label="Match Color" color="fuchsia" icon={PaletteIcon} />
                <QuickAction label="Ask AI" color="sky" icon={SparkleIcon} />
              </div>
            </section>
          </div>

          {/* Reorder Inbox (customer portal) */}
          <section className="bg-slate-900 rounded-xl border border-slate-800">
            <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                  Reorder Inbox
                  <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-teal-900/50 text-teal-400">CUSTOMER PORTAL</span>
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">Incoming reorder requests from customers</p>
              </div>
              <button className="text-xs text-blue-400 hover:text-blue-300 font-medium">Open Inbox →</button>
            </div>
            <div className="grid grid-cols-12 gap-4 px-5 py-2 border-b border-slate-800 text-[10px] font-medium uppercase tracking-wide text-slate-600">
              <div className="col-span-3">Customer</div>
              <div className="col-span-2">Original Order</div>
              <div className="col-span-4">Items</div>
              <div className="col-span-1 text-right">Qty</div>
              <div className="col-span-2 text-right">Status</div>
            </div>
            <div className="divide-y divide-slate-800">
              {REORDER_INBOX.map((r) => (
                <div key={r.order} className="grid grid-cols-12 gap-4 px-5 py-3 items-center hover:bg-slate-800/50 transition-colors">
                  <div className="col-span-3 text-xs font-medium text-slate-100 truncate">{r.customer}</div>
                  <div className="col-span-2"><span className="text-xs font-mono text-slate-400">#{r.order}</span></div>
                  <div className="col-span-4 min-w-0">
                    <div className="text-xs text-slate-300 truncate">{r.items}</div>
                    <div className="text-[10px] text-slate-600">{r.when}</div>
                  </div>
                  <div className="col-span-1 text-right text-xs text-slate-300">{r.qty}</div>
                  <div className="col-span-2 flex justify-end"><StatusBadge status={r.status} /></div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const COLOR_MAP: Record<string, { bg: string; text: string; border: string }> = {
  blue: { bg: "bg-blue-950/40", text: "text-blue-400", border: "border-blue-800/40" },
  green: { bg: "bg-emerald-950/40", text: "text-emerald-400", border: "border-emerald-800/40" },
  orange: { bg: "bg-orange-950/40", text: "text-orange-400", border: "border-orange-800/40" },
  red: { bg: "bg-red-950/40", text: "text-red-400", border: "border-red-800/40" },
  purple: { bg: "bg-violet-950/40", text: "text-violet-400", border: "border-violet-800/40" },
  teal: { bg: "bg-teal-950/40", text: "text-teal-400", border: "border-teal-800/40" },
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

function ModuleCard({ title, desc, stat, color, icon: Icon }: { title: string; desc: string; stat: string; color: string; icon: (p: IconProps) => JSX.Element }) {
  return (
    <button className="text-left bg-slate-900 rounded-xl border border-slate-800 p-3.5 hover:border-slate-600 hover:bg-slate-800/50 transition-colors group">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: color + "22" }}>
          <span style={{ color }}><Icon size={16} active /></span>
        </div>
        <div className="min-w-0">
          <div className="text-xs font-semibold text-white truncate">{title}</div>
          <div className="text-[10px] text-slate-500 truncate">{desc}</div>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-slate-400 truncate">{stat}</span>
        <span className="text-slate-600 group-hover:text-slate-300 transition-colors flex-shrink-0">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
      </div>
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    printed: "bg-emerald-900/50 text-emerald-400",
    shipped: "bg-emerald-900/50 text-emerald-400",
    quoted: "bg-emerald-900/50 text-emerald-400",
    submitted: "bg-blue-900/50 text-blue-400",
    new: "bg-blue-900/50 text-blue-400",
    pending: "bg-yellow-900/50 text-yellow-400",
    reviewed: "bg-amber-900/50 text-amber-400",
    error: "bg-red-900/50 text-red-400",
    failed: "bg-red-900/50 text-red-400",
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium flex-shrink-0 ${map[status] ?? "bg-slate-700 text-slate-300"}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

const ACTION_COLORS: Record<string, string> = {
  blue: "bg-blue-600/15 text-blue-300 hover:bg-blue-600/25 border-blue-700/30",
  amber: "bg-amber-600/15 text-amber-300 hover:bg-amber-600/25 border-amber-700/30",
  rose: "bg-rose-600/15 text-rose-300 hover:bg-rose-600/25 border-rose-700/30",
  violet: "bg-violet-600/15 text-violet-300 hover:bg-violet-600/25 border-violet-700/30",
  emerald: "bg-emerald-600/15 text-emerald-300 hover:bg-emerald-600/25 border-emerald-700/30",
  pink: "bg-pink-600/15 text-pink-300 hover:bg-pink-600/25 border-pink-700/30",
  cyan: "bg-cyan-600/15 text-cyan-300 hover:bg-cyan-600/25 border-cyan-700/30",
  fuchsia: "bg-fuchsia-600/15 text-fuchsia-300 hover:bg-fuchsia-600/25 border-fuchsia-700/30",
  sky: "bg-sky-600/15 text-sky-300 hover:bg-sky-600/25 border-sky-700/30",
  slate: "bg-slate-700/30 text-slate-300 hover:bg-slate-700/50 border-slate-600/30",
};

function QuickAction({ label, color, icon: Icon, badge }: { label: string; color: string; icon: (p: IconProps) => JSX.Element; badge?: string }) {
  return (
    <button className={`relative flex flex-col items-center justify-center gap-1.5 px-2 py-3 rounded-lg border transition-colors ${ACTION_COLORS[color]}`}>
      <Icon size={16} active />
      <span className="text-[10px] font-medium text-center leading-tight">{label}</span>
      {badge && (
        <span className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-rose-500 text-white text-[9px] font-bold flex items-center justify-center">{badge}</span>
      )}
    </button>
  );
}

// ─── Icons ────────────────────────────────────────────────────────────────────
type IconProps = { size?: number; active?: boolean };

function GridIcon({ size = 16, active }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="1" y="1" width="6" height="6" rx="1.5" fill={active ? "white" : "currentColor"} opacity={active ? 1 : 0.7} />
      <rect x="9" y="1" width="6" height="6" rx="1.5" fill={active ? "white" : "currentColor"} opacity={active ? 0.7 : 0.4} />
      <rect x="1" y="9" width="6" height="6" rx="1.5" fill={active ? "white" : "currentColor"} opacity={active ? 0.7 : 0.4} />
      <rect x="9" y="9" width="6" height="6" rx="1.5" fill={active ? "white" : "currentColor"} opacity={active ? 1 : 0.7} />
    </svg>
  );
}

function ChartIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="1" y="9" width="3" height="6" rx="1" fill="currentColor" opacity="0.8" />
      <rect x="6" y="5" width="3" height="10" rx="1" fill="currentColor" opacity="0.8" />
      <rect x="11" y="2" width="3" height="13" rx="1" fill="currentColor" opacity="0.8" />
    </svg>
  );
}

function PrintIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="3" y="1" width="10" height="5" rx="1" fill="currentColor" opacity="0.5" />
      <rect x="1" y="5" width="14" height="7" rx="1.5" fill="currentColor" opacity="0.8" />
      <rect x="3" y="10" width="10" height="5" rx="1" fill="currentColor" opacity="0.5" />
      <rect x="10" y="7.5" width="2" height="2" rx="0.5" fill="currentColor" opacity="1" />
    </svg>
  );
}

function BoxIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M8 1.5L14 4.5V11.5L8 14.5L2 11.5V4.5L8 1.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" opacity="0.85" />
      <path d="M8 1.5V14.5M2 4.5L8 7.5L14 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.85" />
    </svg>
  );
}

function SparkleIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M8 1l1.5 4.5L14 7l-4.5 1.5L8 13l-1.5-4.5L2 7l4.5-1.5L8 1z" fill="currentColor" opacity="0.85" />
    </svg>
  );
}

function GearIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.4" opacity="0.8" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.8" />
    </svg>
  );
}

function ScanIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M1 4V2.5A1.5 1.5 0 012.5 1H4M12 1h1.5A1.5 1.5 0 0115 2.5V4M15 12v1.5a1.5 1.5 0 01-1.5 1.5H12M4 15H2.5A1.5 1.5 0 011 13.5V12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.85" />
      <path d="M1 8h14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function TruckIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="1" y="4" width="8" height="6" rx="1" fill="currentColor" opacity="0.8" />
      <path d="M9 6h3l2 2.5V10H9V6z" fill="currentColor" opacity="0.55" />
      <circle cx="4" cy="11.5" r="1.5" fill="currentColor" />
      <circle cx="11.5" cy="11.5" r="1.5" fill="currentColor" />
    </svg>
  );
}

function CalcIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="2" y="1" width="12" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.3" opacity="0.85" />
      <rect x="4" y="3" width="8" height="3" rx="0.5" fill="currentColor" opacity="0.5" />
      <circle cx="5" cy="9" r="0.9" fill="currentColor" /><circle cx="8" cy="9" r="0.9" fill="currentColor" /><circle cx="11" cy="9" r="0.9" fill="currentColor" />
      <circle cx="5" cy="12" r="0.9" fill="currentColor" /><circle cx="8" cy="12" r="0.9" fill="currentColor" /><circle cx="11" cy="12" r="0.9" fill="currentColor" />
    </svg>
  );
}

function PagesIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="2" y="3" width="8" height="10" rx="1" fill="currentColor" opacity="0.5" />
      <rect x="5" y="1.5" width="8" height="10" rx="1" stroke="currentColor" strokeWidth="1.3" fill="none" opacity="0.9" />
    </svg>
  );
}

function ShieldIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M8 1.5l5.5 2v4c0 3.5-2.4 6-5.5 7-3.1-1-5.5-3.5-5.5-7v-4l5.5-2z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" opacity="0.85" />
      <path d="M5.5 8l1.8 1.8L10.5 6.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function InboxIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M2 9l1.8-6.2A1 1 0 014.76 2h6.48a1 1 0 01.96.8L14 9" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" opacity="0.85" />
      <path d="M2 9h3.5l1 2h3l1-2H14v3.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5V9z" fill="currentColor" opacity="0.75" />
    </svg>
  );
}

function PaletteIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M8 1.5c3.6 0 6.5 2.5 6.5 5.6 0 2-1.7 3.2-3.4 3.2H9.7c-.8 0-1.3.9-.8 1.5.4.5.2 1.4-.6 1.6-.1 0-.2 0-.3.1C4.6 13.9 1.5 11 1.5 7.4 1.5 4 4.4 1.5 8 1.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" opacity="0.85" />
      <circle cx="5" cy="7" r="1" fill="currentColor" /><circle cx="7.5" cy="4.5" r="1" fill="currentColor" /><circle cx="10.8" cy="6" r="1" fill="currentColor" />
    </svg>
  );
}
