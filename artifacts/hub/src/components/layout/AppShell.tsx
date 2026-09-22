import { ReactNode, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useClerk } from "@clerk/react";
import { useGetNeedsOrdering, getGetNeedsOrderingQueryKey } from "@workspace/api-client-react";
import { PrintavoSyncBar } from "@/components/PrintavoSyncBar";
import { useStaff } from "@/components/auth/StaffGate";
import mintLogo from "@assets/MINT_Scripty_1783693134382.png";
import { LayoutDashboard, FileSpreadsheet, CreditCard, Sparkles, Inbox, Scan, Truck, Printer, Palette, Calculator, Package, FileText, Shield, Settings, ClipboardList, Wand2, Zap, Bot, PackageSearch, ChevronDown, LogOut, ListChecks, BadgeDollarSign, Users, Gift, Award, BarChart3, QrCode, SlidersHorizontal, Store, Filter, Search, Star, Menu, X, Mail, Activity, BookOpen, AudioLines } from "lucide-react";

interface NavItem {
  id: string;
  label: string;
  href?: string;
  icon: React.ComponentType<any>;
  badge?: string;
  disabled?: boolean;
  /** Plain <a> navigation to another artifact (full page load, no wouter). */
  external?: boolean;
  /** Hidden from non-admin staff. */
  adminOnly?: boolean;
  requiredCapability?: string;
  /** Module readiness key — hidden from non-admins unless the admin has
   *  switched the module on (Settings → Module access). */
  module?: string;
}

/**
 * Page-route prefixes per module key (keys mirror the server registry in
 * api-server/src/lib/auth/moduleAccess.ts). Used to block direct URL
 * access to pages whose module is switched off for this user.
 */
const MODULE_PAGE_PREFIXES: Record<string, readonly string[]> = {
  reports: ["/orders"],
  payments: ["/payments"],
  "ask-ai": ["/ask"],
  knowledge: ["/knowledge"],
  correspondence: ["/correspondence"],
  "product-finder": ["/product-finder"],
  "garment-pantones": ["/garment-pantones"],
  collections: ["/collections"],
  pipeline: ["/pipeline"],
  "status-activity": ["/status-activity"],
  chipply: ["/chipply"],
  reorder: ["/reorder-requests"],
  customers: ["/customers"],
  purchasing: ["/vendor-orders", "/po-log", "/tracking", "/status-rules"],
  production: ["/print-queue", "/print-queue-rules", "/auto-print"],
  printscope: ["/printscope"],
  "ai-quotes": ["/ai-quotes"],
  "price-calculator": ["/price-calculator"],
  shipping: ["/rate-estimator", "/label-sorter"],
  mintbucks: ["/mintbucks"],
  backups: ["/backups"],
};

function moduleForPath(path: string): string | null {
  if (path === "/") return "dashboard";
  for (const [key, prefixes] of Object.entries(MODULE_PAGE_PREFIXES)) {
    for (const prefix of prefixes) {
      if (path === prefix || path.startsWith(prefix + "/")) return key;
    }
  }
  return null;
}

interface NavGroup {
  heading: string | null;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    heading: null,
    items: [
      { id: "dashboard", label: "Dashboard", href: "/", icon: LayoutDashboard, module: "dashboard" },
    ],
  },
  {
    heading: "Analyze",
    items: [
      { id: "reports", label: "Reports", href: "/orders", icon: FileSpreadsheet, module: "reports" },
      { id: "payments", label: "Payments", href: "/payments", icon: CreditCard, module: "payments" },
      { id: "ai", label: "Ask AI", href: "/ask", icon: Sparkles, module: "ask-ai" },
      { id: "knowledge", label: "Knowledge Base", href: "/knowledge", icon: BookOpen, module: "knowledge" },
      { id: "ai-connections", label: "AI Connections", href: "/ai-connections", icon: Bot, adminOnly: true },
      { id: "voice-profiles", label: "Voice Profiles", href: "/voice-profiles", icon: AudioLines },
      { id: "email-activity", label: "Email Activity", href: "/email-activity", icon: Mail, requiredCapability: "view_email_activity" },
      { id: "email-access", label: "Email Access", href: "/email-activity/access", icon: Shield, adminOnly: true },
      { id: "correspondence", label: "Correspondence", href: "/correspondence", icon: Inbox, module: "correspondence" },
    ],
  },
  {
    heading: "Sales",
    items: [
      { id: "product-finder", label: "Product Finder", href: "/product-finder", icon: Search, module: "product-finder" },
      { id: "garment-pantones", label: "Garment Pantones", href: "/garment-pantones", icon: Palette, module: "garment-pantones" },
      { id: "collections", label: "Collections", href: "/collections", icon: Star, module: "collections" },
      { id: "pipeline", label: "Pipeline", href: "/pipeline", icon: Filter, module: "pipeline" },
      { id: "status-activity", label: "Status Activity", href: "/status-activity", icon: Activity, module: "status-activity" },
      { id: "chipply", label: "Chipply Stores", href: "/chipply", icon: Store, module: "chipply" },
      { id: "reorders", label: "Reorder Requests", href: "/reorder-requests", icon: Inbox, module: "reorder" },
    ],
  },
  {
    heading: "Clients",
    items: [
      { id: "customers", label: "Directory", href: "/customers", icon: Users, module: "customers" },
      { id: "niche-report", label: "Niche Report", href: "/customers/report", icon: BarChart3, module: "customers" },
    ],
  },
  {
    heading: "Purchasing",
    items: [
      { id: "reorder", label: "Reorder Scan", icon: Scan, disabled: true },
      { id: "vendor", label: "Vendor Orders", href: "/vendor-orders", icon: Truck, module: "purchasing" },
      { id: "polog", label: "PO Log", href: "/po-log", icon: ClipboardList, module: "purchasing" },
      { id: "tracking", label: "Order Tracking", href: "/tracking", icon: PackageSearch, module: "purchasing" },
      { id: "statusrules", label: "Status Rules", href: "/status-rules", icon: Wand2, module: "purchasing" },
    ],
  },
  {
    heading: "Production",
    items: [
      { id: "print", label: "Print Queue", href: "/print-queue", icon: Printer, module: "production" },
      { id: "printscope", label: "SepScope", href: "/printscope", icon: Scan, module: "printscope" },
      { id: "pqrules", label: "Queue Rules", href: "/print-queue-rules", icon: Zap, module: "production" },
      { id: "autoprint", label: "Auto-Print", href: "/auto-print", icon: Bot, module: "production" },
      { id: "colors", label: "Color Library", icon: Palette, disabled: true },
    ],
  },
  {
    heading: "Quoting",
    items: [
      { id: "ai-quotes", label: "AI Quote Drafts", href: "/ai-quotes", icon: Wand2, module: "ai-quotes" },
      { id: "quote", label: "Price Calculator", href: "/price-calculator", icon: Calculator, module: "price-calculator" }
    ],
  },
  {
    heading: "Team",
    items: [{ id: "momintum", label: "Tasks (moMINTum)", href: "/momintum/", icon: ListChecks, external: true, module: "momintum" }],
  },
  {
    heading: "Shipping",
    items: [
      { id: "rates", label: "Rate Estimator", href: "/rate-estimator", icon: Package, module: "shipping" },
      { id: "sorter", label: "Label Sorter", href: "/label-sorter", icon: FileText, module: "shipping" },
    ],
  },
  {
    heading: "Mint Bucks",
    items: [
      { id: "mb-dashboard", label: "MB Dashboard", href: "/mintbucks", icon: BadgeDollarSign, module: "mintbucks" },
      { id: "mb-customers", label: "Customers", href: "/mintbucks/customers", icon: Users, module: "mintbucks" },
      { id: "mb-credits", label: "Credits", href: "/mintbucks/credits", icon: CreditCard, module: "mintbucks" },
      { id: "mb-redemptions", label: "Redemptions", href: "/mintbucks/redemptions", icon: Gift, module: "mintbucks" },
      { id: "mb-rewards", label: "Rewards", href: "/mintbucks/rewards", icon: Award, module: "mintbucks" },
      { id: "mb-reports", label: "Reports", href: "/mintbucks/reports", icon: BarChart3, module: "mintbucks" },
      { id: "mb-check", label: "Check Credit", href: "/mintbucks/check", icon: QrCode, module: "mintbucks" },
      { id: "mb-settings", label: "MB Settings", href: "/mintbucks/settings", icon: SlidersHorizontal, module: "mintbucks" },
    ],
  },
  {
    heading: "Data",
    items: [{ id: "backups", label: "Backups", href: "/backups", icon: Shield, module: "backups" }],
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
  const { role, capabilities, enabledModules } = useStaff();
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(loadCollapsedGroups);
  /** Mobile drawer state — the sidebar is hidden by default below lg. */
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Close the drawer whenever navigation happens.
  useEffect(() => {
    setSidebarOpen(false);
  }, [location]);

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
  // The vendor badge polls /purchasing — skip it entirely when the
  // Purchasing module is off for this user (the call would only 403).
  const canPurchasing = role === "admin" || enabledModules.includes("purchasing");
  const { data: needsOrdering } = useGetNeedsOrdering({
    query: {
      queryKey: getGetNeedsOrderingQueryKey(),
      staleTime: 60_000,
      enabled: canPurchasing,
    },
  });
  const vendorBadge = needsOrdering && needsOrdering.totalLineItems > 0
    ? String(needsOrdering.totalLineItems)
    : undefined;

  // Direct-URL guard: pages of switched-off modules render a lock panel
  // instead of the page (the API blocks their calls anyway).
  const currentModule = moduleForPath(location);
  const moduleLocked =
    currentModule !== null &&
    role !== "admin" &&
    !enabledModules.includes(currentModule);

  return (
    <div className="flex h-dvh bg-[#020617] text-slate-100 font-sans overflow-hidden">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}
      {/* Sidebar — slide-over drawer below lg, static column at lg+ */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-60 flex flex-col bg-[#0f172a] border-r border-slate-800 flex-shrink-0 transform transition-transform duration-200 ease-out lg:static lg:z-auto lg:translate-x-0 lg:transition-none ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="px-5 py-5 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <img
              src={mintLogo}
              alt="Mint Printworks"
              className="h-10 w-auto flex-shrink-0 drop-shadow-[0_0_10px_rgba(5,150,105,0.35)]"
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-white leading-none tracking-tight">Printavo Hub</div>
              <div className="text-[10px] text-slate-400 mt-0.5 font-medium">Mint Printworks</div>
            </div>
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className="lg:hidden p-1.5 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
              aria-label="Close menu"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <nav className="flex-1 px-3 py-3 space-y-4 overflow-y-auto custom-scrollbar">
          {NAV_GROUPS.map((rawGroup, gi) => {
            const group = {
              ...rawGroup,
              items: rawGroup.items.filter(
                (item) =>
                  (!item.adminOnly || role === "admin") &&
                  (!item.requiredCapability || capabilities.includes(item.requiredCapability)) &&
                  (!item.module || role === "admin" || enabledModules.includes(item.module)),
              ),
            };
            if (group.items.length === 0) return null;
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
        {/* Mobile top bar */}
        <div className="lg:hidden flex items-center gap-3 px-3 py-2 border-b border-slate-800 bg-[#0f172a] flex-shrink-0">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="p-2 rounded-md text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>
          <img src={mintLogo} alt="Mint Printworks" className="h-7 w-auto" />
          <span className="text-sm font-semibold text-white tracking-tight">Printavo Hub</span>
        </div>
        <PrintavoSyncBar />
        <main className="flex-1 overflow-y-auto bg-[#020617] relative custom-scrollbar">
          {moduleLocked ? (
            <div className="flex min-h-full items-center justify-center px-4">
              <div className="w-full max-w-md rounded-xl border border-slate-800 bg-[#0f172a] p-8 text-center">
                <Shield className="mx-auto text-slate-500" size={32} />
                <h1 className="mt-4 text-lg font-semibold text-slate-100">
                  This module isn't enabled yet
                </h1>
                <p className="mt-2 text-sm text-slate-400">
                  An admin hasn't switched this part of the Hub on for your
                  account. Use the menu to find your available tools, or ask
                  an admin to enable it in Settings.
                </p>
              </div>
            </div>
          ) : (
            children
          )}
        </main>
      </div>
    </div>
  );
}
