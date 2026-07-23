import { useEffect, useRef } from "react";
import { Switch, Route, useLocation, Router as WouterRouter } from "wouter";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { dark } from "@clerk/themes";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { StaffGate } from "@/components/auth/StaffGate";
import mintLogo from "@assets/MINT_Scripty_1783693134382.png";

import Landing from "./pages/Landing";
import Dashboard from "./pages/Dashboard";
import Orders from "./pages/Orders";
import Payments from "./pages/Payments";
import VendorOrders from "./pages/VendorOrders";
import PoLog from "./pages/PoLog";
import VendorTracking from "./pages/VendorTracking";
import StatusRules from "./pages/StatusRules";
import PrintQueue from "./pages/PrintQueue";
import PrintQueueRules from "./pages/PrintQueueRules";
import AutoPrint from "./pages/AutoPrint";
import PriceCalculator from "./pages/PriceCalculator";
import LabelSorter from "./pages/LabelSorter";
import RateEstimator from "./pages/RateEstimator";
import Settings from "./pages/Settings";
import BackupDashboard from "./pages/BackupDashboard";
import { Dashboard as MintBucksDashboard } from "./pages/mintbucks/Dashboard";
import { Customers as MintBucksCustomers } from "./pages/mintbucks/Customers";
import { CustomerDetail as MintBucksCustomerDetail } from "./pages/mintbucks/CustomerDetail";
import { Credits as MintBucksCredits } from "./pages/mintbucks/Credits";
import { IssueCredit as MintBucksIssueCredit } from "./pages/mintbucks/IssueCredit";
import { CreditDetail as MintBucksCreditDetail } from "./pages/mintbucks/CreditDetail";
import { Redemptions as MintBucksRedemptions } from "./pages/mintbucks/Redemptions";
import { Reports as MintBucksReports } from "./pages/mintbucks/Reports";
import { Rewards as MintBucksRewards } from "./pages/mintbucks/Rewards";
import { Settings as MintBucksSettings } from "./pages/mintbucks/Settings";
import { CertificateHistory as MintBucksCertificateHistory } from "./pages/mintbucks/CertificateHistory";
import { CheckCredit as MintBucksCheckCredit } from "./pages/mintbucks/CheckCredit";

const queryClient = new QueryClient();

// REQUIRED — copy verbatim. Resolves the key from window.location.hostname so the
// same build serves multiple Clerk custom domains. Do not inline the env var, leave
// publishableKey undefined, or replace publishableKeyFromHost with anything else.
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

// REQUIRED — copy verbatim. Empty in dev (Clerk hits dev FAPI directly), auto-set
// in prod. Do NOT gate on import.meta.env.PROD / NODE_ENV — the empty dev value
// is intentional, and any branching breaks the prod proxy.
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// Clerk passes full paths to routerPush/routerReplace, but wouter's
// setLocation prepends the base — strip it to avoid doubling.
function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in .env file");
}

const clerkAppearance = {
  theme: dark,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${mintLogo}`,
  },
  variables: {
    colorPrimary: "#059669",
    colorForeground: "#f1f5f9",
    colorMutedForeground: "#94a3b8",
    colorDanger: "#f87171",
    colorBackground: "#0f172a",
    colorInput: "#1e293b",
    colorInputForeground: "#f1f5f9",
    colorNeutral: "#f8fafc",
    fontFamily: "'Inter', sans-serif",
    borderRadius: "0.5rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox:
      "bg-[#0f172a] border border-slate-800 rounded-2xl w-[420px] max-w-full overflow-hidden shadow-2xl",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-slate-100 font-semibold tracking-tight",
    headerSubtitle: "text-slate-400",
    socialButtonsBlockButtonText: "text-slate-100 font-medium",
    formFieldLabel: "text-slate-300",
    footerActionLink: "text-[#10b981] hover:text-[#34d399]",
    footerActionText: "text-slate-400",
    dividerText: "text-slate-500",
    identityPreviewEditButton: "text-[#10b981]",
    formFieldSuccessText: "text-emerald-400",
    alertText: "text-slate-200",
    logoBox: "justify-center",
    logoImage: "h-10 w-auto",
    socialButtonsBlockButton:
      "bg-slate-800 hover:bg-slate-700 border border-slate-700",
    formButtonPrimary: "bg-[#059669] hover:bg-[#047857] text-white",
    formFieldInput: "bg-[#1e293b] border-slate-700 text-slate-100",
    footerAction: "justify-center",
    dividerLine: "bg-slate-800",
    alert: "bg-slate-800 border border-slate-700",
    otpCodeFieldInput: "bg-[#1e293b] border-slate-700 text-slate-100",
    formFieldRow: "gap-2",
    main: "gap-5",
  },
};

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#020617] px-4">
      {/* path must be the full browser path — Clerk reads window.location.pathname directly */}
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
      />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#020617] px-4">
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
      />
    </div>
  );
}

// Helps user's webview stay up-to-date when the signed-in user changes by
// invalidating the QueryClient cache.
function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function HubRoutes() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/orders" component={Orders} />
      <Route path="/payments" component={Payments} />
      <Route path="/vendor-orders" component={VendorOrders} />
      <Route path="/po-log" component={PoLog} />
      <Route path="/tracking" component={VendorTracking} />
      <Route path="/status-rules" component={StatusRules} />
      <Route path="/print-queue" component={PrintQueue} />
      <Route path="/print-queue-rules" component={PrintQueueRules} />
      <Route path="/auto-print" component={AutoPrint} />
      <Route path="/price-calculator" component={PriceCalculator} />
      <Route path="/label-sorter" component={LabelSorter} />
      <Route path="/rate-estimator" component={RateEstimator} />
      <Route path="/settings" component={Settings} />
      <Route path="/backups" component={BackupDashboard} />
      <Route path="/mintbucks" component={MintBucksDashboard} />
      <Route path="/mintbucks/customers" component={MintBucksCustomers} />
      <Route path="/mintbucks/customers/:id" component={MintBucksCustomerDetail} />
      <Route path="/mintbucks/credits/new" component={MintBucksIssueCredit} />
      <Route path="/mintbucks/credits/:id" component={MintBucksCreditDetail} />
      <Route path="/mintbucks/credits" component={MintBucksCredits} />
      <Route path="/mintbucks/redemptions" component={MintBucksRedemptions} />
      <Route path="/mintbucks/rewards" component={MintBucksRewards} />
      <Route path="/mintbucks/reports/certificates" component={MintBucksCertificateHistory} />
      <Route path="/mintbucks/reports" component={MintBucksReports} />
      <Route path="/mintbucks/settings" component={MintBucksSettings} />
      <Route path="/mintbucks/check/:code" component={MintBucksCheckCredit} />
      <Route path="/mintbucks/check" component={MintBucksCheckCredit} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AppRoutes() {
  return (
    <Switch>
      {/* REQUIRED — copy "/sign-in/*?" and "/sign-up/*?" verbatim. The /*? optional
          wildcard is the only wouter syntax that matches both the bare URL and Clerk's
          OAuth sub-paths. Not /sign-in, not /sign-in/*, not /sign-in/:rest*. */}
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      <Route>
        {/* Signed-out visitors see the public landing on every path —
            never an auto-redirect to sign-in. */}
        <Show when="signed-out">
          <Landing />
        </Show>
        <Show when="signed-in">
          <StaffGate>
            <HubRoutes />
          </StaffGate>
        </Show>
      </Route>
    </Switch>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Printavo Hub",
            subtitle: "Sign in with your staff account",
          },
        },
        signUp: {
          start: {
            title: "Printavo Hub",
            subtitle: "Staff accounts must be added by an admin first",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <AppRoutes />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
