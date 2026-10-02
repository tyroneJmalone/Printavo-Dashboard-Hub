import { activityChangeRows } from "./orderActivityChanges";

export function OrderActivityChange({ field, before, after }: { field: string; before?: string | null; after?: string | null }) {
  const rows = activityChangeRows(field, before, after);
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-slate-700">
      <table className="w-full table-fixed text-left text-xs" aria-label="Line-item change comparison">
        <thead className="bg-slate-900 text-slate-400">
          <tr>
            <th className="w-1/4 px-3 py-2 font-medium">Field</th>
            <th className="px-3 py-2 font-medium text-rose-300">Before</th>
            <th className="px-3 py-2 font-medium text-emerald-300">After</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.label} className="border-t border-slate-800 align-top">
              <th scope="row" className="px-3 py-2 font-medium text-slate-300 break-words">
                {row.label}
                <span className={`mt-1 block text-[10px] ${row.changed ? "text-amber-300" : "text-slate-500"}`}>{row.changed ? "Changed" : "Unchanged"}</span>
              </th>
              <td className={`px-3 py-2 whitespace-pre-wrap break-words ${row.changed ? "bg-rose-500/5 text-rose-200" : "text-slate-500"}`}>{row.before}</td>
              <td className={`px-3 py-2 whitespace-pre-wrap break-words ${row.changed ? "bg-emerald-500/5 font-medium text-emerald-200" : "text-slate-500"}`}>{row.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}