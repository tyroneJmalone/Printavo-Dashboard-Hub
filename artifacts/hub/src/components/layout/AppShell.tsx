import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useGetNeedsOrdering, getGetNeedsOrderingQueryKey } from "@workspace/api-client-react";
import { LayoutDashboard, FileSpreadsheet, CreditCard, Sparkles, Inbox, Scan, Truck, Printer, Palette, Calculator, Package, FileText, Shield, Settings, ClipboardList } from "lucide-react";

interface NavItem {
  id: string;
  label: string;
  href?: string;
  icon: React.ComponentType<any>;
  badge?: string;
  disabled?: boolean;
}

interface NavGroup {
  heading: string | null;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    heading: null,
    items: [
      { id: "dashboard", label: "Dashboard", href: "/", icon: LayoutDashboard },
    ],
  },
  {
    heading: "Analyze",
    items: [
      { id: "reports", label: "Reports", href: "/orders", icon: FileSpreadsheet },
      { id: "payments", label: "Payments", href: "/payments", icon: CreditCard },
      { id: "ai", label: "Ask AI", icon: Sparkles, disabled: true },
    ],
  },
  {
    heading: "Sales",
    items: [{ id: "reorders", label: "Reorder Inbox", icon: Inbox, disabled: true }],
  },
  {
    heading: "Purchasing",
    items: [
      { id: "reorder", label: "Reorder Scan", icon: Scan, disabled: true },
      { id: "vendor", label: "Vendor Orders", href: "/vendor-orders", icon: Truck },
      { id: "polog", label: "PO Log", href: "/po-log", icon: ClipboardList },
    ],
  },
  {
    heading: "Production",
    items: [
      { id: "print", label: "Print Queue", icon: Printer, disabled: true },
      { id: "colors", label: "Color Library", icon: Palette, disabled: true },
    ],
  },
  {
    heading: "Quoting",
    items: [{ id: "quote", label: "Price Calculator", icon: Calculator, disabled: true }],
  },
  {
    heading: "Shipping",
    items: [
      { id: "rates", label: "Rate Estimator", icon: Package, disabled: true },
      { id: "sorter", label: "Label Sorter", icon: FileText, disabled: true },
    ],
  },
  {
    heading: "Data",
    items: [{ id: "backups", label: "Backups", icon: Shield, disabled: true }],
  },
];

export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { data: needsOrdering } = useGetNeedsOrdering({
    query: { queryKey: getGetNeedsOrderingQueryKey(), staleTime: 60_000 },
  });
  const vendorBadge = needsOrdering && needsOrdering.totalLineItems > 0
    ? String(needsOrdering.totalLineItems)
    : undefined;

  return (
    <div className="flex h-screen bg-[#020617] text-slate-100 font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-60 flex flex-col bg-[#0f172a] border-r border-slate-800 flex-shrink-0">
        <div className="px-5 py-5 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-[#059669] flex items-center justify-center flex-shrink-0 shadow-[0_0_12px_rgba(5,150,105,0.4)]">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="1" y="1" width="5" height="5" rx="1" fill="#022c22" opacity="0.9" />
                <rect x="8" y="1" width="5" height="5" rx="1" fill="#022c22" opacity="0.6" />
                <rect x="1" y="8" width="5" height="5" rx="1" fill="#022c22" opacity="0.6" />
                <rect x="8" y="8" width="5" height="5" rx="1" fill="#022c22" opacity="0.9" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-semibold text-white leading-none tracking-tight">Printavo Hub</div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-medium">Mint Print Works</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-3 py-3 space-y-4 overflow-y-auto custom-scrollbar">
          {NAV_GROUPS.map((group, gi) => (
            <div key={gi}>
              {group.heading && (
                <div className="px-3 mb-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500">{group.heading}</div>
              )}
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const isActive = item.href && location === item.href;
                  const badge = item.id === "vendor" ? vendorBadge : item.badge;
                  
                  const content = (
                    <div className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-[13px] font-medium transition-colors text-left ${
                      isActive 
                        ? "bg-[#059669]/10 text-[#10b981] border border-[#059669]/20" 
                        : item.disabled
                          ? "text-slate-600 cursor-not-allowed"
                          : "text-slate-400 hover:text-slate-100 hover:bg-slate-800 border border-transparent"
                    }`}>
                      <item.icon size={15} strokeWidth={isActive ? 2.5 : 2} className={isActive ? "text-[#10b981]" : ""} />
                      <span className="flex-1">{item.label}</span>
                      {badge && (
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded text-center min-w-[20px] ${isActive ? "bg-[#059669]/20 text-[#10b981]" : "bg-slate-800 text-slate-400"}`}>
                          {badge}
                        </span>
                      )}
                    </div>
                  );

                  if (item.disabled || !item.href) {
                    return <div key={item.id}>{content}</div>;
                  }

                  return (
                    <Link key={item.id} href={item.href} className="block">
                      {content}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="px-3 py-2 border-t border-slate-800">
          <button
            disabled
            className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-[13px] font-medium transition-colors text-left text-slate-600 cursor-not-allowed border border-transparent"
          >
            <Settings size={15} />
            Settings
          </button>
        </div>

        <div className="px-4 py-4 border-t border-slate-800 bg-slate-900/50">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded bg-slate-800 flex items-center justify-center text-xs font-bold text-slate-300 border border-slate-700 shadow-inner">MP</div>
            <div>
              <div className="text-xs font-semibold text-slate-200">Shop Manager</div>
              <div className="text-[10px] text-slate-500 font-mono mt-0.5">admin@mintprint</div>
            </div>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto bg-[#020617] relative custom-scrollbar">
        {children}
      </main>
    </div>
  );
}
