import { Fragment, useState, useEffect } from "react";
import { 
  useGetPrintscopeRules, 
  getGetPrintscopeRulesQueryKey,
  useUpdatePrintscopeRules,
  useListPrintscopeRuleVersions,
  getListPrintscopeRuleVersionsQueryKey,
  useGetPrintscopeRuleVersion,
  getGetPrintscopeRuleVersionQueryKey,
  PrintscopeRuleVersion,
  PrintscopeRuleRow
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Save, ChevronLeft } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useStaff } from "@/components/auth/StaffGate";

type Guidance = {
  decision: "build_now" | "validation_pending" | "held" | "disabled_recalibration";
  definition: string;
  exceptions: string;
  validationSamples: string;
  asOf: string;
  source: string;
  scope: "current_guidance";
};
type RuleMetadata = {
  implemented: boolean;
  fields: string[];
  thresholds: string[];
  severityPolicy?: "info";
  guidance?: Guidance;
};
const decisionLabels: Record<Guidance["decision"], string> = {
  build_now: "Build now",
  validation_pending: "Validation pending · raster",
  held: "Held · blocked",
  disabled_recalibration: "Disabled · recalibration",
};

export function PrintScopeRules() {
  const { data: currentVersion, isLoading: currentLoading, error: currentError } = useGetPrintscopeRules({
    // Refresh on navigation, not while an administrator has an in-progress draft.
    query: { queryKey: getGetPrintscopeRulesQueryKey(), refetchOnMount: "always", refetchOnWindowFocus: false, refetchOnReconnect: false }
  });
  
  const { data: history, isLoading: historyLoading, error: historyError } = useListPrintscopeRuleVersions({
    query: { queryKey: getListPrintscopeRuleVersionsQueryKey() }
  });

  const [viewingVersionId, setViewingVersionId] = useState<number | null>(null);

  const { data: viewedVersion, isLoading: viewedLoading, error: viewedError } = useGetPrintscopeRuleVersion(
    String(viewingVersionId),
    { query: { enabled: viewingVersionId !== null, queryKey: getGetPrintscopeRuleVersionQueryKey(String(viewingVersionId)) } }
  );

  const activeVersion = viewingVersionId !== null ? viewedVersion : currentVersion;
  const isLoading = (viewingVersionId === null && currentLoading) || (viewingVersionId !== null && viewedLoading);
  
  return (
    <div className="wrap !grid-cols-[288px_1fr]">
      <aside className="rail">
        <div className="railhead">
          <h1 style={{ fontSize: "13px" }}>Rule History</h1>
          <span className="lbl">{history?.length || 0} versions</span>
        </div>
        <div className="qlist">
          {historyLoading && <div className="p-4 text-center text-ink-3">Loading...</div>}
          {historyError && <p role="alert" className="p-4 text-sm">Rule history could not be loaded. Reload to try again.</p>}
          {history?.map((v) => (
            <button 
              key={v.id}
              data-testid={`button-rule-version-${v.id}`}
              className="qitem" 
              aria-current={(viewingVersionId === null && v.id === currentVersion?.id) || viewingVersionId === v.id ? "true" : "false"}
              onClick={() => setViewingVersionId(v.id === currentVersion?.id ? null : v.id)}
            >
              <span className="stripe" style={{ background: v.id === currentVersion?.id ? "var(--accent)" : "var(--line-2)" }}></span>
              <span className="body flex flex-col">
                <span className="fn text-[13px]">{v.id === currentVersion?.id ? "Current Version" : `Version ${v.id}`}</span>
                <span className="qmeta">
                  <span>{new Date(v.createdAt).toLocaleDateString()}</span>
                  <span className="ml-auto">{v.hash.substring(0,8)}</span>
                </span>
              </span>
            </button>
          ))}
        </div>
      </aside>
      
      <main className="detail" style={{ background: "var(--surface)", minHeight: "100%", padding: "24px 28px" }}>
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="animate-spin text-ink-3" />
          </div>
        ) : (viewingVersionId === null ? currentError : viewedError) ? (
          <p role="alert" data-testid="error-rules">Rules could not be loaded. Reload to try again.</p>
        ) : activeVersion ? (
          <RuleEditor 
            version={activeVersion} 
            isHistorical={viewingVersionId !== null && viewingVersionId !== currentVersion?.id} 
            onBackToCurrent={() => setViewingVersionId(null)}
          />
        ) : null}
      </main>
    </div>
  );
}

function RuleEditor({ version, isHistorical, onBackToCurrent }: { version: PrintscopeRuleVersion, isHistorical: boolean, onBackToCurrent: () => void }) {
  const { role } = useStaff();
  const readOnly = isHistorical || role !== "admin";
  const [rows, setRows] = useState<PrintscopeRuleRow[]>([]);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateRules = useUpdatePrintscopeRules();

  useEffect(() => {
    setRows(JSON.parse(JSON.stringify(version.rows)));
  }, [version.id]);

  const editableMap = (version.editable ?? {}) as Record<string, RuleMetadata>;
  const guidanceEntries = Object.values(editableMap).flatMap(meta => meta.guidance ? [meta.guidance] : []);
  const invalidThresholds = rows.some(row => {
    try {
      const values = { ...JSON.parse(row.expected), ...JSON.parse(row.tolerance) };
      return (editableMap[row.code]?.thresholds ?? []).some(key =>
        values[key] !== undefined && (typeof values[key] !== "number" ||
          !Number.isFinite(values[key]) || values[key] < 0 || values[key] > (key.includes("pct") ? 100 : 10000))
      ) || values.trap_required_below_pct > values.trap_not_required_above_pct ||
        values.partial_below_pct > values.partial_above_pct;
    } catch { return true; }
  });

  const handleRowChange = (index: number, key: string, value: string) => {
    const newRows = [...rows];
    newRows[index] = { ...newRows[index], [key]: value };
    setRows(newRows);
  };

  const handleSave = async () => {
    if (readOnly || invalidThresholds) return;
    try {
      await updateRules.mutateAsync({
        data: {
          expectedVersion: version.id,
          rows: rows
        }
      });
      toast({
        title: "Rules updated",
        description: "New rule version has been created.",
      });
      queryClient.invalidateQueries({ queryKey: getGetPrintscopeRulesQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListPrintscopeRuleVersionsQueryKey() });
    } catch (e: any) {
      toast({
        title: "Failed to update rules",
        description: e.message || "Invalid thresholds or conflict.",
        variant: "destructive"
      });
    }
  };

  const hasChanges = JSON.stringify(rows) !== JSON.stringify(version.rows);

  return (
    <div className="flex flex-col h-full max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-8 pb-4 border-b border-line">
        <div>
          <h2 className="text-2xl font-bold font-[Archivo]">{isHistorical ? `Historical Version ${version.id}` : "Current Rules"}</h2>
          <div className="text-sm text-ink-3 font-mono mt-1">
            {version.hash} &middot; {new Date(version.createdAt).toLocaleString()}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {isHistorical && (
            <button 
              onClick={onBackToCurrent}
              data-testid="button-current-rules"
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-surface-2 hover:bg-line text-ink-2 rounded font-semibold"
            >
              <ChevronLeft size={16} /> Current
            </button>
          )}
          {!readOnly && (
            <button 
              onClick={handleSave}
              data-testid="button-save-rules"
              disabled={!hasChanges || invalidThresholds || updateRules.isPending}
              className="flex items-center gap-2 px-4 py-1.5 text-sm bg-[#0B6E63] hover:bg-[#09554D] text-white disabled:opacity-50 disabled:cursor-not-allowed rounded font-semibold"
            >
              {updateRules.isPending ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              Save Changes
            </button>
          )}
        </div>
      </div>
      <section className="mb-6 rounded border border-line bg-surface-2 p-4 text-sm" aria-label="Current consultant guidance" data-testid="section-consultant-guidance">
        <h3 className="font-semibold font-[Archivo]">
          Current consultant guidance{guidanceEntries[0] ? ` · ${guidanceEntries[0].asOf}` : ""}
        </h3>
        {guidanceEntries.length > 0 ? (
          <>
            <p className="mt-2" data-testid="text-guidance-counts">
              {guidanceEntries.filter(g => g.decision === "build_now").length} build now ·{" "}
              {guidanceEntries.filter(g => g.decision === "validation_pending").length} validation pending (raster) ·{" "}
              {guidanceEntries.filter(g => g.decision === "held").length} held ·{" "}
              {guidanceEntries.filter(g => g.decision === "disabled_recalibration").length} disabled for recalibration
            </p>
            <p className="mt-2 text-ink-2">
              Expand any guided rule for the consultant’s full definition, exceptions, and evidence gaps.
              Build decisions are not proof of validation. Raster checks have no real-image coverage in the 55-file corpus.
              Held checks need external context or agreed presets; CHOKE_SAFE_FOR_DETAIL stays off.
            </p>
          </>
        ) : <p role="status" className="mt-2">Consultant guidance metadata is unavailable from this server.</p>}
        <p className="mt-2 text-ink-2" data-testid="text-guidance-snapshot-separation">
          {isHistorical ? `Settings below are the unchanged historical snapshot v${version.id}. ` : `Settings below belong to snapshot v${version.id}. `}
          Guidance and detector availability describe the current code, not what was implemented or known when this snapshot was saved.
          Reading guidance does not change settings or past results. Only an administrator’s explicit save publishes a new snapshot.
        </p>
      </section>
      {role !== "admin" && <p className="mb-4 text-sm">Read-only rules. Only administrators can publish a new rule version.</p>}
      {invalidThresholds && <p role="alert" className="mb-4 text-sm text-red-600">Correct invalid thresholds before saving. Values must be nonnegative, percentages cannot exceed 100, and lower bounds cannot exceed upper bounds.</p>}

      <div className="flex-1 overflow-auto -mx-4 px-4 custom-scrollbar">
        <table className="w-full text-sm text-left border-collapse">
          <thead>
            <tr className="border-b-2 border-line-2 text-ink-3 uppercase tracking-wider text-[11px] font-[Archivo]">
              <th className="py-2 pl-2">Rule Code</th>
              <th className="py-2">Saved status</th>
              <th className="py-2 w-32">Saved severity</th>
              <th className="py-2">Thresholds</th>
              <th className="py-2 pr-2 w-1/3">Remediation</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const code = row.code || row.rule;
              const edMeta = editableMap[code] || { implemented: false, fields: [], thresholds: [] };
              const isUnimplemented = !edMeta.implemented;
              const guidance = edMeta.guidance;
              
              const canEditEnable = edMeta.fields.includes("enabled") && !readOnly;
              const canEditSeverity = edMeta.fields.includes("severity") && !readOnly;
              const canEditRemediation = edMeta.fields.includes("remediation_text") && !readOnly;
              
              const expectedKeys = edMeta.thresholds || [];
              let combinedThresholds: Record<string, number> = {};
              try {
                combinedThresholds = { ...JSON.parse(row.expected || "{}"), ...JSON.parse(row.tolerance || "{}") };
              } catch (e) {
                // Ignore parse errors, just use empty
              }
              
              const handleThresholdChange = (key: string, value: string) => {
                const numVal = parseFloat(value);
                if (isNaN(numVal)) return;
                
                const newRows = [...rows];
                try {
                  // Replit rules logic merges expected and tolerance.
                  // We update the expected JSON if the key exists there, else tolerance.
                  // Default to expected if neither has it yet.
                  const expectedObj = JSON.parse(newRows[i].expected || "{}");
                  const toleranceObj = JSON.parse(newRows[i].tolerance || "{}");
                  
                  if (key in toleranceObj) {
                    toleranceObj[key] = numVal;
                    newRows[i] = { ...newRows[i], tolerance: JSON.stringify(toleranceObj) };
                  } else {
                    expectedObj[key] = numVal;
                    newRows[i] = { ...newRows[i], expected: JSON.stringify(expectedObj) };
                  }
                  setRows(newRows);
                } catch (e) {
                  console.error(e);
                }
              };
              
              return (
                <Fragment key={code}>
                <tr className="border-b border-line hover:bg-surface-2/50 group transition-colors" data-testid={`row-rule-${code}`}>
                  <td className="py-3 pl-2 align-top">
                    <div className="font-semibold font-[Archivo] text-[13px]">{row.name || code}</div>
                    <div className="font-mono text-[10px] text-ink-3 mt-1">{code}</div>
                    {guidance && <div className="mt-2 text-xs font-semibold text-ink-2" data-testid={`status-guidance-${code}`}>{decisionLabels[guidance.decision]}</div>}
                    <div className="mt-1 text-xs text-ink-3" data-testid={`status-detector-${code}`}>
                      Current detector: {guidance?.decision === "held" ? "held, not active" : guidance?.decision === "disabled_recalibration" ? "disabled pending recalibration" : isUnimplemented ? "not built" : "available"}
                    </div>
                  </td>
                  <td className="py-3 align-top">
                    {canEditEnable ? (
                      <select 
                        aria-label={`${code} saved status`}
                        data-testid={`select-enabled-${code}`}
                        value={row.enabled?.toString() || "true"} 
                        onChange={(e) => handleRowChange(i, "enabled", e.target.value)}
                        className="bg-surface border border-line rounded px-2 py-1 text-xs"
                      >
                        <option value="true">Enabled</option>
                        <option value="false">Disabled</option>
                      </select>
                    ) : (
                      <span className="inline-block px-2 py-0.5 rounded text-[10px] uppercase font-[Archivo] bg-line text-ink-3" data-testid={`text-saved-enabled-${code}`}>
                        {row.enabled === "false" || row.enabled === "0" ? "Disabled" : "Enabled"}
                      </span>
                    )}
                  </td>
                  <td className="py-3 align-top">
                    {canEditSeverity ? (
                      <select 
                        aria-label={`${code} saved severity`}
                        data-testid={`select-severity-${code}`}
                        value={row.severity} 
                        onChange={(e) => handleRowChange(i, "severity", e.target.value)}
                        className="bg-surface border border-line rounded px-2 py-1 text-xs w-24"
                      >
                        <option value="fail" disabled={edMeta.severityPolicy === "info"}>Fail</option>
                        <option value="flag" disabled={edMeta.severityPolicy === "info"}>Flag</option>
                        <option value="info">Info</option>
                      </select>
                    ) : (
                      <span className="text-xs uppercase font-[Archivo] text-ink-2">{row.severity || "-"}</span>
                    )}
                    {edMeta.severityPolicy === "info" && (
                      <p className="mt-2 text-xs text-ink-2" data-testid={`text-severity-policy-${code}`}>
                        Current policy: info only, including runs using legacy settings.
                        {row.severity !== "info" && " Saved severity is retained, not promoted to a judgement. An admin may explicitly save Info."}
                      </p>
                    )}
                  </td>
                  <td className="py-3 align-top font-mono text-xs">
                    {expectedKeys.map((k: string) => (
                      <div key={k} className="mb-2 last:mb-0 flex flex-col">
                        <span className="text-[10px] text-ink-3 mb-0.5">{k}</span>
                        {!readOnly ? (
                          <input 
                            aria-label={`${code} ${k}`}
                            data-testid={`input-threshold-${code}-${k}`}
                            type="number" 
                            step="any"
                            value={combinedThresholds[k] ?? ""} 
                            onChange={(e) => handleThresholdChange(k, e.target.value)}
                            className="bg-surface border border-line rounded px-2 py-1 w-full max-w-[120px]"
                          />
                        ) : (
                          <span>{combinedThresholds[k] ?? "-"}</span>
                        )}
                      </div>
                    ))}
                    {expectedKeys.length === 0 && <span className="text-ink-3">-</span>}
                  </td>
                  <td className="py-3 pr-2 align-top">
                    {canEditRemediation ? (
                      <textarea 
                        aria-label={`${code} remediation`}
                        data-testid={`input-remediation-${code}`}
                        value={row.remediation_text || row.remediation || ""} 
                        onChange={(e) => handleRowChange(i, "remediation_text", e.target.value)}
                        className="bg-surface border border-line rounded px-2 py-1 w-full text-xs min-h-[60px] resize-y custom-scrollbar"
                        placeholder="Remediation instructions..."
                      />
                    ) : (
                      <div className="text-xs text-ink-2 whitespace-pre-wrap">{row.remediation_text || row.remediation || "-"}</div>
                    )}
                  </td>
                </tr>
                {guidance && (
                  <tr className="border-b border-line" data-testid={`row-guidance-${code}`}>
                    <td colSpan={5} className="px-2 pb-3">
                      <details className="rounded border border-line bg-surface-2 p-3" data-testid={`details-guidance-${code}`}>
                        <summary className="cursor-pointer text-sm font-semibold" data-testid={`button-guidance-${code}`}>
                          Consultant guidance · {decisionLabels[guidance.decision]} · {code}
                        </summary>
                        <p className="mt-3 text-xs text-ink-3">
                          Current guidance as of {guidance.asOf} — not part of saved snapshot v{version.id}.
                        </p>
                        <dl className="mt-4 space-y-4 text-sm leading-relaxed">
                          <div>
                            <dt className="font-semibold">Definition / build decision</dt>
                            <dd className="mt-1 whitespace-pre-wrap" data-testid={`text-definition-${code}`}>{guidance.definition}</dd>
                          </div>
                          <div>
                            <dt className="font-semibold">Exceptions / legitimate cases</dt>
                            <dd className="mt-1 whitespace-pre-wrap" data-testid={`text-exceptions-${code}`}>{guidance.exceptions}</dd>
                          </div>
                          <div>
                            <dt className="font-semibold">Validation samples / evidence gaps</dt>
                            <dd className="mt-1 whitespace-pre-wrap" data-testid={`text-validation-${code}`}>{guidance.validationSamples}</dd>
                          </div>
                        </dl>
                        <p className="mt-4 text-xs text-ink-3 break-all">Source: {guidance.source}</p>
                      </details>
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
