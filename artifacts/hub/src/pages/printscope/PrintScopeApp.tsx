import type { ReactNode } from "react";
import { Switch, Route, useLocation } from "wouter";
import { PrintScopeJobs } from "./PrintScopeJobs";
import { PrintScopeRules } from "./PrintScopeRules";
import { PrintScopePilot } from "./PrintScopePilot";
import { PrintScopeAutomation } from "./PrintScopeAutomation";
import "./Printscope.css";
import { useStaff } from "@/components/auth/StaffGate";
import { useGetPrintscopeCapabilities, getGetPrintscopeCapabilitiesQueryKey } from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Link } from "wouter";

export default function PrintScopeApp() {
  const { role } = useStaff();
  
  const { data: caps, isLoading, error } = useGetPrintscopeCapabilities({
    query: {
      queryKey: getGetPrintscopeCapabilitiesQueryKey(),
      refetchInterval: (query) => query.state.data?.available === false ? 15_000 : false,
    }
  });

  let content: ReactNode;
  if (isLoading) {
    content = (
      <div className="flex min-h-full items-center justify-center p-8">
        <Loader2 className="h-8 w-8 animate-spin text-slate-500" />
      </div>
    );
  }

  else if (error || !caps) {
    content = (
      <div className="flex min-h-full items-center justify-center p-8">
        <div className="text-center text-slate-500">Failed to load SepScope capabilities.</div>
      </div>
    );
  } else content = (
    <div className="printscope-app relative h-full">
      <header className="top">
        <span className="brand"><span className="dot"></span>SepScope</span>
        <span className="lbl">separation inspection &middot; Mint Printworks</span>
        <div className="flex gap-4 ml-8">
          <Link href="/printscope" className="text-xs font-semibold hover:text-[var(--accent)]">Jobs</Link>
          {role === "admin" && (
            <Link href="/printscope/rules" className="text-xs font-semibold hover:text-[var(--accent)]">Rules</Link>
          )}
          <Link href="/printscope/pilot" className="text-xs font-semibold hover:text-[var(--accent)]">Pilot</Link>
          <Link href="/printscope/automation" className="text-xs font-semibold hover:text-[var(--accent)]">Automation</Link>
        </div>
        <span className="legend">
          <span className="key"><i style={{ background: "var(--fail)" }}></i>send it back</span>
          <span className="key"><i style={{ background: "var(--flag)" }}></i>look at it</span>
          <span className="key"><i style={{ background: "var(--pass)" }}></i>clear to run</span>
        </span>
      </header>

      <Switch>
        <Route path="/printscope/rules" component={PrintScopeRules} />
        <Route path="/printscope/automation" component={PrintScopeAutomation} />
        <Route path="/printscope/pilot" component={PrintScopePilot} />
        <Route path="/printscope" component={() => <PrintScopeJobs caps={caps} />} />
        {/* Wildcard catchall */}
        <Route component={() => <PrintScopeJobs caps={caps} />} />
      </Switch>
    </div>
  );

  return <AppShell>{content}</AppShell>;
}
