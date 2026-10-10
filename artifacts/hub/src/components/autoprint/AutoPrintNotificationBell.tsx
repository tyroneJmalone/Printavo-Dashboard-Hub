import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Bell, X } from "lucide-react";
import { useStaff } from "@/components/auth/StaffGate";
import { useAutoPrintNotificationList } from "./useAutoPrintNotifications";
import { AutoPrintNotificationList } from "./AutoPrintNotificationList";

function BellInner({ align }: { align: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { query, data } = useAutoPrintNotificationList(0);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  const unread = data?.unread ?? 0;
  const badge = query.isError ? "!" : query.isLoading ? null : unread > 0 ? (unread > 99 ? "99+" : String(unread)) : null;
  const title = query.isError ? "AutoPrint notifications could not load" : query.isLoading ? "Loading AutoPrint notifications" : `${unread} unread AutoPrint notifications`;

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-label={title} title={title} aria-expanded={open} data-testid="button-autoprint-bell"
        className={`relative rounded-md p-2 transition-colors hover:bg-slate-800 ${query.isError ? "text-red-300" : "text-slate-300 hover:text-white"}`}>
        <Bell size={18} />
        {badge && (
          <span data-testid="badge-autoprint-unread" className={`absolute -right-0.5 -top-0.5 min-w-[16px] rounded-full px-1 text-center text-[9px] font-bold leading-4 ${query.isError ? "bg-red-500 text-white" : "bg-[#059669] text-white"}`}>{badge}</span>
        )}
      </button>
      {open && (
        <div role="dialog" aria-label="AutoPrint notifications" className={`fixed inset-x-2 top-14 z-50 rounded-xl border border-slate-700 bg-[#0f172a] p-3 shadow-2xl sm:absolute sm:inset-x-auto ${align === "left" ? "sm:left-0" : "sm:right-0"} sm:top-full sm:mt-1 sm:w-[440px]`}>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-100">AutoPrint alerts</h2>
            <Link href="/auto-print#autoprint-notifications" onClick={() => setOpen(false)} data-testid="link-notification-inbox" className="ml-auto text-[12px] text-sky-300 underline underline-offset-2">Open inbox</Link>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close notifications" className="rounded p-1 text-slate-400 hover:text-white"><X size={14} /></button>
          </div>
          <AutoPrintNotificationList compact onNavigate={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

/** Renders nothing (and issues no requests) for non-admin staff. */
export function AutoPrintNotificationBell({ align = "right" }: { align?: "left" | "right" }) {
  const { role } = useStaff();
  return role === "admin" ? <BellInner align={align} /> : null;
}
