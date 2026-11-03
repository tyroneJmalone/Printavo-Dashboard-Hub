export function PrintNodeObservation({ metadata, accepted }: { metadata: unknown; accepted: boolean }) {
  if (!accepted) return null;
  const monitor = (metadata as { printNodeMonitor?: { state?: string; message?: string; checkedAt?: string } } | null)?.printNodeMonitor;
  if (!monitor?.state) return <p className="text-slate-400">PrintNode monitoring: no check recorded. Accepted does not confirm paper output.</p>;
  const label = monitor.state === "done" ? "Delivered to the computer’s print queue — paper output not confirmed"
    : monitor.state === "error" ? "PrintNode reported an error"
    : monitor.state === "expired" ? "Expired before delivery to the PrintNode client"
    : monitor.state === "unavailable" ? "Status check unavailable — outcome unconfirmed"
    : `PrintNode: ${monitor.state}`;
  return <div className={["error", "expired", "unavailable"].includes(monitor.state) ? "text-amber-300" : "text-slate-300"}>
    <p>{label}</p>
    {monitor.message && <p className="whitespace-pre-wrap">{monitor.message}</p>}
    {monitor.checkedAt && <p className="text-slate-500">Last checked: {new Date(monitor.checkedAt).toLocaleString()}</p>}
  </div>;
}
