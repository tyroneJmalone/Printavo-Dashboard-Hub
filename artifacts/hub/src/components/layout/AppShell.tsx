import { ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import { useClerk } from "@clerk/react";
import { useGetNeedsOrdering, getGetNeedsOrderingQueryKey } from "@workspace/api-client-react";
import { PrintavoSyncBar } from "@/components/PrintavoSyncBar";
import { useStaff } from "@/components/auth/StaffGate";
import mintLogo from "@assets/MINT_Scripty_1783693134382.png";
import { LayoutDashboard, FileSpreadsheet, CreditCard, Sparkles, Inbox, Scan, Truck, Printer, Palette, Calculator, Package, FileText, Shield, Settings, ClipboardList, Wand2, Zap, Bot, PackageSearch, ChevronDown, LogOut, ListChecks, BadgeDollarSign, Users, Gift, Award, BarChart3, QrCode, SlidersHorizontal, Store, Filter } from "lucide-react";

interface NavItem {
  id: string;
  label: string;
  href?: string;
  icon: React.ComponentType<any>;
  badge?: string;
  disabled?: boolean;
  /** Plain <a> navigation to another artifact (full page load, no wouter). */
  external?: boolean;
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
      { id: "ai", label: "Ask AI", href: "/ask", icon: Sparkles },
    ],
  },
  {
    heading: "Sales",
    items: [
      { id: "pipeline", label: "Pipeline", href: "/pipeline", icon: Filter },
      { id: "chipply", label: "Chipply Stores", href: "/chipply", icon: Store },
      { id: "reorders", label: "Reorder Inbox", icon: Inbox, disabled: true },
    ],
  },
  {
    heading: "Clients",
    items: [
      { id: "customers", label: "Directory", href: "/customers", icon: Users },
      { id: "niche-report", label: "Niche Report", href: "/customers/report", icon: BarChart3 },
    ],
  },
  {
    heading: "Purchasing",
    items: [
      { id: "reorder", label: "Reorder Scan", icon: Scan, disabled: true },
      { id: "vendor", label: "Vendor Orders", href: "/vendor-orders", icon: Truck },
      { id: "polog", label: "PO Log", href: "/po-log", icon: ClipboardList },
      { id: "tracking", label: "Order Tracking", href: "/tracking", icon: PackageSearch },
      { id: "statusrules", label: "Status Rules", href: "/status-rules", icon: Wand2 },
    ],
  },
  {
    heading: "Production",
    items: [
      { id: "print", label: "Print Queue", href: "/print-queue", icon: Printer },
      { id: "pqrules", label: "Queue Rules", href: "/print-queue-rules", icon: Zap },
      { id: "autoprint", label: "Auto-Print", href: "/auto-print", icon: Bot },
      { id: "colors", label: "Color Library", icon: Palette, disabled: true },
    ],
  },
  {
    heading: "Quoting",
    items: [{ id: "quote", label: "Price Calculator", href: "/price-calculator", icon: Calculator }],
  },
  {
    heading: "Team",
    items: [{ id: "momintum", label: "Tasks (moMINTum)", href: "/momintum/", icon: ListChecks, external: true }],
  },
  {
    heading: "Shipping",
    items: [
      { id: "rates", label: "Rate Estimator", href: "/rate-estimator", icon: Package },
      { id: "sorter", label: "Label Sorter", href: "/label-sorter", icon: FileText },
    ],
  },
  {
    heading: "Mint Bucks",
    items: [
      { id: "mb-dashboard", label: "MB Dashboard", href: "/mintbucks", icon: BadgeDollarSign },
      { id: "mb-customers", label: "Customers", href: "/mintbucks/customers", icon: Users },
      { id: "mb-credits", label: "Credits", href: "/mintbucks/credits", icon: CreditCard },
      { id: "mb-redemptions", label: "Redemptions", href: "/mintbucks/redemptions", icon: Gift },
      { id: "mb-rewards", label: "Rewards", href: "/mintbucks/rewards", icon: Award },
      { id: "mb-reports", label: "Reports", href: "/mintbucks/reports", icon: BarChart3 },
      { id: "mb-check", label: "Check Credit", href: "/mintbucks/check", icon: QrCode },
      { id: "mb-settings", label: "MB Settings", href: "/mintbucks/settings", icon: SlidersHorizontal },
    ],
  },
  {
    heading: "Data",
    items: [{ id: "backups", label: "Backups", href: "/backups", icon: Shield }],
  },
];

const COLLAPSED_GROUPS_KEY = "hub.nav.collapsedGroups";

function loadCollapsedGroups(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    return {};
  }
}

function StaffChip() {
  const { email, role } = useStaff();
  const { signOut } = useClerk();
  const initials = email.slice(0, 2).toUpperCase();

  return (
    <div className="px-4 py-4 border-t border-slate-800 bg-slate-900/50">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded bg-slate-800 flex items-center justify-center text-xs font-bold text-slate-300 border border-slate-700 shadow-inner flex-shrink-0">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-slate-200 capitalize">
            {role}
          </div>
          <div className="text-[10px] text-slate-500 font-mono mt-0.5 truncate" title={email}>
            {email}
          </div>
        </div>
        <button
          type="button"
          onClick={() => signOut()}
          title="Sign out"
          className="p-1.5 rounded-md text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors flex-shrink-0"
        >
          <LogOut size={14} />
        </button>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(loadCollapsedGroups);

  const toggleGroup = (heading: string) => {
    setCollapsedGroups((prev) => {
      const next = { ...prev, [heading]: !prev[heading] };
      try {
        localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(next));
      } catch {
        // localStorage unavailable — collapse state just won't persist
      }
      return next;
    });
  };
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
            <img
              src={mintLogo}
              alt="Mint Printworks"
              className="h-10 w-auto flex-shrink-0 drop-shadow-[0_0_10px_rgba(5,150,105,0.35)]"
            />
            <div>
              <div className="text-sm font-semibold text-white leading-none tracking-tight">Printavo Hub</div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-medium">Mint Printworks</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-3 py-3 space-y-4 overflow-y-auto custom-scrollbar">
          {NAV_GROUPS.map((group, gi) => {
            const isCollapsed = group.heading ? !!collapsedGroups[group.heading] : false;
            const hasActive = group.items.some((item) => item.href && location === item.href);
            return (
            <div key={gi}>
              {group.heading && (
                <button
                  type="button"
                  onClick={() => toggleGroup(group.heading!)}
                  className={`w-full flex items-center justify-between px-3 mb-1.5 text-[10px] font-bold uppercase tracking-widest transition-colors group ${
                    isCollapsed && hasActive ? "text-[#10b981]" : "text-slate-500 hover:text-slate-300"
                  }`}
                  aria-expanded={!isCollapsed}
                >
                  <span>{group.heading}</span>
                  <ChevronDown
                    size={12}
                    className={`opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-all ${isCollapsed ? "-rotate-90 opacity-60" : ""}`}
                  />
                </button>
              )}
              {!isCollapsed && (
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

                  if (item.external) {
                    return (
                      <a key={item.id} href={item.href} className="block">
                        {content}
                      </a>
                    );
                  }

                  return (
                    <Link key={item.id} href={item.href} className="block">
                      {content}
                    </Link>
                  );
                })}
              </div>
              )}
            </div>
            );
          })}
        </nav>

        <div className="px-3 py-2 border-t border-slate-800">
          <Link href="/settings" className="block">
            <div
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-[13px] font-medium transition-colors text-left ${
                location === "/settings"
                  ? "bg-[#059669]/10 text-[#10b981] border border-[#059669]/20"
                  : "text-slate-400 hover:text-slate-100 hover:bg-slate-800 border border-transparent"
              }`}
            >
              <Settings size={15} strokeWidth={location === "/settings" ? 2.5 : 2} className={location === "/settings" ? "text-[#10b981]" : ""} />
              Settings
            </div>
          </Link>
        </div>

        <StaffChip />
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <PrintavoSyncBar />
        <main className="flex-1 overflow-y-auto bg-[#020617] relative custom-scrollbar">
          {children}
        </main>
      </div>
    </div>
  );
}
