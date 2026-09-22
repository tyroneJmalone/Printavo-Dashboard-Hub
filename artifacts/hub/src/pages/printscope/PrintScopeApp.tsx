import { Switch, Route, useLocation } from "wouter";
import { PrintScopeJobs } from "./PrintScopeJobs";
import { PrintScopeRules } from "./PrintScopeRules";
import "./Printscope.css";
import { Shield } from "lucide-react";
import { useStaff } from "@/components/auth/StaffGate";
import { useGetPrintscopeCapabilities, getGetPrintscopeCapabilitiesQueryKey } from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";
import { Link } from "wouter";

export default function PrintScopeApp() {
  const { role, enabledModules } = useStaff();
  
  const { data: caps, isLoading, error } = useGetPrintscopeCapabilities({
    query: { queryKey: getGetPrintscopeCapabilitiesQueryKey() }
  });

  if (isLoading) {
    return (
      <div className="flex min-h-full items-center justify-center p-8">
        <Loader2 className="h-8 w-8 animate-spin text-slate-500" />
      </div>
    );
  }

  if (error || !caps) {
    return (
      <div className="flex min-h-full items-center justify-center p-8">
        <div className="text-center text-slate-500">Failed to load PrintScope capabilities.</div>
      </div>
    );
  }

  return (
    <div className="printscope-app relative h-full">
      <header className="top">
        <span className="brand"><span className="dot"></span>PrintScope</span>
        <span className="lbl">separation inspection &middot; Mint Printworks</span>
        <div className="flex gap-4 ml-8">
          <Link href="/printscope" className="text-xs font-semibold hover:text-[#0B6E63]">Jobs</Link>
          {role === "admin" && (
            <Link href="/printscope/rules" className="text-xs font-semibold hover:text-[#0B6E63]">Rules</Link>
          )}
        </div>
        <span className="legend">
          <span className="key"><i style={{ background: "var(--fail)" }}></i>send it back</span>
          <span className="key"><i style={{ background: "var(--flag)" }}></i>look at it</span>
          <span className="key"><i style={{ background: "var(--pass)" }}></i>clear to run</span>
        </span>
      </header>

      <Switch>
        <Route path="/printscope/rules" component={PrintScopeRules} />
        <Route path="/printscope" component={() => <PrintScopeJobs caps={caps} />} />
        {/* Wildcard catchall */}
        <Route component={() => <PrintScopeJobs caps={caps} />} />
      </Switch>
    </div>
  );
}
