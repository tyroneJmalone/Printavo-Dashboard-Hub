import { useState } from "react";
import {
  useGetAdminPinStatus,
  getGetAdminPinStatusQueryKey,
  useSetAdminPin,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { KeyRound, Loader2, Save } from "lucide-react";

function apiError(err: unknown): string | undefined {
  const e = err as { data?: { error?: string }; message?: string } | undefined;
  return e?.data?.error ?? e?.message;
}

const inputCls =
  "bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-[#059669] placeholder:text-slate-600";
const labelCls =
  "flex flex-col gap-1.5 text-[11px] text-slate-400 font-semibold uppercase tracking-wide";

const PIN_RE = /^\d{4,12}$/;

export function AdminPinCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: status, isLoading } = useGetAdminPinStatus({
    query: { queryKey: getGetAdminPinStatusQueryKey() },
  });

  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");

  const save = useSetAdminPin({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetAdminPinStatusQueryKey() });
        setCurrentPin("");
        setNewPin("");
        setConfirmPin("");
        toast({
          title: "Admin PIN updated",
          description: "The new PIN is active immediately.",
        });
      },
      onError: (err) =>
        toast({
          title: "Couldn't change PIN",
          description: apiError(err) ?? "Save failed",
          variant: "destructive",
        }),
    },
  });

  const configured = status?.configured ?? false;
  const newPinValid = PIN_RE.test(newPin);
  const pinsMatch = newPin === confirmPin;
  const currentOk = !configured || currentPin.length > 0;
  const canSave = newPinValid && pinsMatch && currentOk && !save.isPending;

  const hint = !newPin
    ? configured
      ? "Enter your current PIN and a new 4–12 digit PIN."
      : "Set a 4–12 digit PIN."
    : !newPinValid
      ? "PIN must be 4–12 digits."
      : !pinsMatch
        ? "New PINs don't match."
        : !currentOk
          ? "Enter your current PIN."
          : "Ready to save.";

  const onSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    save.mutate({
      data: {
        newPin,
        ...(configured ? { currentPin } : {}),
      },
    });
  };

  return (
    <form
      onSubmit={onSave}
      className="bg-slate-900/40 border border-slate-800 rounded-xl overflow-hidden"
    >
      <div className="px-5 py-4 border-b border-slate-800 flex items-center gap-2.5">
        <KeyRound size={16} className="text-amber-400" />
        <div>
          <div className="text-sm font-semibold text-slate-100">Admin PIN</div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            Required to submit vendor orders and unlock submitted POs.
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 size={18} className="animate-spin text-slate-500" />
        </div>
      ) : (
        <div className="p-5 flex flex-col gap-4">
          {status?.source === "secret" && (
            <p className="text-[11px] text-amber-400/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
              The PIN currently comes from the ADMIN_PIN secret. Saving a new
              PIN here moves it into the app — the secret is then ignored.
            </p>
          )}
          {!configured && (
            <p className="text-[11px] text-slate-400 bg-slate-800/60 border border-slate-700 rounded-lg px-3 py-2">
              No PIN is set yet — vendor submissions and admin unlocks are
              blocked until you set one.
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {configured && (
              <label className={labelCls}>
                Current PIN
                <input
                  className={inputCls}
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  value={currentPin}
                  onChange={(e) => setCurrentPin(e.target.value)}
                  placeholder="••••"
                />
              </label>
            )}
            <label className={labelCls}>
              New PIN
              <input
                className={inputCls}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={12}
                value={newPin}
                onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))}
                placeholder="4–12 digits"
              />
            </label>
            <label className={labelCls}>
              Confirm new PIN
              <input
                className={inputCls}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={12}
                value={confirmPin}
                onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ""))}
                placeholder="Repeat it"
              />
            </label>
          </div>
        </div>
      )}

      <div className="px-5 py-4 border-t border-slate-800 flex items-center justify-between">
        <span className="text-[11px] text-slate-500">{hint}</span>
        <button
          type="submit"
          disabled={!canSave}
          className="flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-lg bg-[#059669]/10 border border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {save.isPending ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Save size={13} />
          )}
          {configured ? "Change PIN" : "Set PIN"}
        </button>
      </div>
    </form>
  );
}
