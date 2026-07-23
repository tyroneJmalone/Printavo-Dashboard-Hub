import { AppShell } from "@/components/layout/AppShell";
import { useStaff } from "@/components/auth/StaffGate";
import {
  useGetBackupStatus,
  getGetBackupStatusQueryKey,
} from "@workspace/api-client-react";
import { formatNumber } from "@/lib/format";
import {
  Shield,
  Download,
  Database,
  FileArchive,
  MessageSquare,
  Layers,
  CheckCircle2,
  Loader2,
  AlertTriangle,
} from "lucide-react";

const TABLE_LABELS: Record<string, string> = {
  pv_orders: "Orders (quotes + invoices)",
  pv_line_items: "Line items",
  pv_line_item_groups: "Line item groups",
  pv_imprints: "Imprints",
  pv_customers: "Customers",
  pv_contacts: "Contacts",
  pv_payments: "Payments",
  pv_statuses: "Statuses",
  pv_threads: "Message threads",
  pv_messages: "Messages",
  pv_inquiries: "Inquiries",
  pv_payment_requests: "Payment requests",
  pv_merch_stores: "Merch stores",
  pv_merch_orders: "Merch orders",
  pv_reference_blobs: "Account reference data",
  pv_files: "File registry",
  change_events: "Change history (Hub-observed)",
};

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const diffMin = Math.floor(Math.max(0, Date.now() - new Date(iso).getTime()) / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  const hrs = Math.floor(diffMin / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function ProgressBar({ done, total, color }: { done: number; total: number; color: string }) {
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  return (
    <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function BackupDashboard() {
  const { role } = useStaff();
  const { data, isLoading } = useGetBackupStatus({
    query: {
      queryKey: getGetBackupStatusQueryKey(),
      refetchInterval: 30_000,
    },
  });

  const totalRows = data?.tables.reduce((s, t) => s + t.rows, 0) ?? 0;
  const mirrored = data?.files.find((f) => f.status === "mirrored");
  const pendingFiles = data?.files.find((f) => f.status === "pending");
  const failedFiles = data?.files.find((f) => f.status === "failed");
  const filesTotal = data?.files.reduce((s, f) => s + f.count, 0) ?? 0;
  const extrasPct =
    data && data.extras.total > 0
      ? ((data.extras.done / data.extras.total) * 100).toFixed(1)
      : "0";
  const messagesDone = data ? data.threads.total - data.threads.messagesPending : 0;

  return (
    <AppShell>
      <div className="sticky top-0 z-10 bg-[#020617]/80 backdrop-blur-md border-b border-slate-800 px-8 py-5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
            <Shield size={20} className="text-[#10b981]" />
            Printavo Backup
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Everything the Hub has archived from Printavo — refreshed every 5 minutes
          </p>
        </div>
        {role === "admin" && (
          <a
            href="/api/backup/export"
            download
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
              data?.exportInFlight
                ? "bg-slate-800 text-slate-500 cursor-not-allowed pointer-events-none"
                : "bg-[#10b981] hover:bg-[#059669] text-slate-950"
            }`}
          >
            {data?.exportInFlight ? (
              <>
                <Loader2 size={16} className="animate-spin" /> Export running…
              </>
            ) : (
              <>
                <Download size={16} /> Download backup (.zip)
              </>
            )}
          </a>
        )}
      </div>

      <div className="px-8 py-8 max-w-7xl mx-auto space-y-8">
        {isLoading || !data ? (
          <div className="animate-pulse space-y-8">
            <div className="grid grid-cols-4 gap-4">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-32 bg-slate-900 rounded-xl border border-slate-800" />
              ))}
            </div>
            <div className="h-96 bg-slate-900 rounded-xl border border-slate-800" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-5 relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                  <Database size={64} className="text-[#10b981]" />
                </div>
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                  Records Archived
                </div>
                <div className="text-3xl font-bold text-white">{formatNumber(totalRows)}</div>
                <div className="text-xs text-slate-500 mt-2">
                  Across {data.tables.length} tables
                </div>
              </div>

              <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-5 relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                  <Layers size={64} className="text-blue-500" />
                </div>
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                  Order Detail Archive
                </div>
                <div className="text-3xl font-bold text-white">{extrasPct}%</div>
                <div className="mt-3">
                  <ProgressBar done={data.extras.done} total={data.extras.total} color="bg-blue-500" />
                </div>
                <div className="text-xs text-slate-500 mt-2">
                  {formatNumber(data.extras.done)} of {formatNumber(data.extras.total)} orders with full detail
                </div>
              </div>

              <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-5 relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                  <FileArchive size={64} className="text-amber-500" />
                </div>
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                  Files Mirrored
                </div>
                <div className="text-3xl font-bold text-white">
                  {formatNumber(mirrored?.count ?? 0)}
                </div>
                <div className="mt-3">
                  <ProgressBar done={mirrored?.count ?? 0} total={filesTotal} color="bg-amber-500" />
                </div>
                <div className="text-xs text-slate-500 mt-2">
                  {formatBytes(mirrored?.bytes ?? 0)} saved · {formatNumber(pendingFiles?.count ?? 0)} pending
                  {failedFiles && failedFiles.count > 0 ? ` · ${formatNumber(failedFiles.count)} failed` : ""}
                </div>
              </div>

              <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-5 relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                  <MessageSquare size={64} className="text-indigo-500" />
                </div>
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                  Message Threads
                </div>
                <div className="text-3xl font-bold text-white">{formatNumber(messagesDone)}</div>
                <div className="mt-3">
                  <ProgressBar done={messagesDone} total={data.threads.total} color="bg-indigo-500" />
                </div>
                <div className="text-xs text-slate-500 mt-2">
                  of {formatNumber(data.threads.total)} threads fully captured
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 bg-slate-900/40 rounded-xl border border-slate-800">
                <div className="px-6 py-5 border-b border-slate-800">
                  <h2 className="text-base font-bold text-white flex items-center gap-2">
                    <Database size={18} className="text-[#10b981]" />
                    What's in the backup
                  </h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="text-xs text-slate-400 bg-slate-900/80 uppercase">
                      <tr>
                        <th className="px-6 py-3 font-semibold">Data</th>
                        <th className="px-6 py-3 font-semibold text-right">Records</th>
                        <th className="px-6 py-3 font-semibold text-right">Last Activity</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {data.tables.map((t) => (
                        <tr key={t.table} className="hover:bg-slate-800/30 transition-colors">
                          <td className="px-6 py-3">
                            <div className="font-medium text-slate-200">
                              {TABLE_LABELS[t.table] ?? t.table}
                            </div>
                            <div className="text-[11px] text-slate-500 font-mono">{t.table}</div>
                          </td>
                          <td className="px-6 py-3 text-right font-mono text-slate-300">
                            {formatNumber(t.rows)}
                          </td>
                          <td className="px-6 py-3 text-right text-slate-400">
                            {relTime(t.lastActivityAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="space-y-6">
                <div className="bg-slate-900/40 rounded-xl border border-slate-800 p-6">
                  <h2 className="text-base font-bold text-white flex items-center gap-2 mb-4">
                    {data.lastIncremental?.status === "completed" ? (
                      <CheckCircle2 size={18} className="text-[#10b981]" />
                    ) : data.lastIncremental?.status === "running" ? (
                      <Loader2 size={18} className="text-sky-400 animate-spin" />
                    ) : (
                      <AlertTriangle size={18} className="text-amber-500" />
                    )}
                    Last Sync
                  </h2>
                  {data.lastIncremental ? (
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Status</span>
                        <span
                          className={
                            data.lastIncremental.status === "completed"
                              ? "text-[#10b981] font-medium"
                              : data.lastIncremental.status === "running"
                                ? "text-sky-400 font-medium"
                                : "text-amber-500 font-medium"
                          }
                        >
                          {data.lastIncremental.status}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Started</span>
                        <span className="text-slate-300">{relTime(data.lastIncremental.startedAt)}</span>
                      </div>
                      {data.lastIncremental.finishedAt && (
                        <div className="flex justify-between">
                          <span className="text-slate-400">Finished</span>
                          <span className="text-slate-300">{relTime(data.lastIncremental.finishedAt)}</span>
                        </div>
                      )}
                      {data.lastIncremental.error && (
                        <div className="text-xs text-red-400 mt-2 break-words">
                          {data.lastIncremental.error}
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-500">No sync has run yet.</p>
                  )}
                </div>

                <div className="bg-slate-900/40 rounded-xl border border-slate-800 p-6">
                  <h2 className="text-base font-bold text-white mb-4">Sync Watermarks</h2>
                  <div className="space-y-2 text-sm">
                    {data.watermarks.map((w) => (
                      <div key={w.entity} className="flex justify-between">
                        <span className="text-slate-400 capitalize">{w.entity.replace(/_/g, " ")}</span>
                        <span className="text-slate-300">{relTime(w.watermark)}</span>
                      </div>
                    ))}
                    {data.watermarks.length === 0 && (
                      <p className="text-slate-500">No watermarks yet.</p>
                    )}
                  </div>
                </div>

                <div className="bg-slate-900/40 rounded-xl border border-slate-800 p-6">
                  <h2 className="text-base font-bold text-white mb-2">About the export</h2>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    The download is a ZIP with one file per table (NDJSON format — one record
                    per line) plus a manifest. It includes the raw Printavo data for every
                    record. Mirrored PDFs, mockups and production files stay in cloud storage;
                    the file registry in the export lists where each one lives.
                    {role !== "admin" && " Only admins can download the export."}
                  </p>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
