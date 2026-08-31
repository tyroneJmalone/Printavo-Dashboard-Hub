import { ReactNode, createContext, useContext } from "react";
import { useClerk, useUser } from "@clerk/react";
import {
  useGetAuthMe,
  getGetAuthMeQueryKey,
  ApiError,
  type AuthMe,
} from "@workspace/api-client-react";
import { ShieldX, RefreshCw, LogOut } from "lucide-react";

const StaffContext = createContext<AuthMe | null>(null);

/** Signed-in staff identity (email + role). Only usable inside StaffGate. */
export function useStaff(): AuthMe {
  const staff = useContext(StaffContext);
  if (!staff) throw new Error("useStaff must be used inside StaffGate");
  return staff;
}

function FullScreen({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      {children}
    </div>
  );
}

/**
 * Server-side allowlist gate. Rendered only when Clerk says signed-in;
 * asks the API who this session belongs to. 403 (not on the staff list)
 * gets a clear "ask an admin" screen with sign-out — NOT an error screen.
 */
export function StaffGate({ children }: { children: ReactNode }) {
  const { signOut } = useClerk();
  const { user } = useUser();
  const { data, isLoading, error, refetch, isRefetching } = useGetAuthMe({
    query: {
      queryKey: getGetAuthMeQueryKey(),
      retry: false,
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: false,
    },
  });

  if (isLoading) {
    return (
      <FullScreen>
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <RefreshCw className="animate-spin" size={22} />
          <div className="text-sm">Checking your access…</div>
        </div>
      </FullScreen>
    );
  }

  if (error instanceof ApiError && error.status === 403) {
    const email = user?.primaryEmailAddress?.emailAddress ?? "";
    return (
      <FullScreen>
        <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 text-center shadow-lg">
          <ShieldX className="mx-auto text-amber-500" size={36} />
          <h1 className="mt-4 text-lg font-semibold text-foreground">
            Not on the staff list
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {email ? (
              <>
                <span className="font-mono text-foreground">{email}</span> isn't
                authorized for moMINTum yet.
              </>
            ) : (
              "This account isn't authorized for moMINTum yet."
            )}{" "}
            Ask an admin to add you in Printavo Hub Settings, then sign in
            again.
          </p>
          <button
            type="button"
            onClick={() => signOut()}
            className="mt-6 inline-flex items-center gap-2 rounded-md bg-muted px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/80"
          >
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </FullScreen>
    );
  }

  if (error || !data) {
    return (
      <FullScreen>
        <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 text-center shadow-lg">
          <h1 className="text-lg font-semibold text-foreground">
            Couldn't verify your access
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Something went wrong while checking your staff account.
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isRefetching}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              <RefreshCw
                size={14}
                className={isRefetching ? "animate-spin" : ""}
              />
              Try again
            </button>
            <button
              type="button"
              onClick={() => signOut()}
              className="inline-flex items-center gap-2 rounded-md bg-muted px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/80"
            >
              <LogOut size={14} /> Sign out
            </button>
          </div>
        </div>
      </FullScreen>
    );
  }

  // Module readiness gate: moMINTum can be switched off for non-admins in
  // Hub Settings → Module access. Show a clear lock screen instead of a
  // task app whose every API call would 403.
  if (data.role !== "admin" && !data.enabledModules.includes("momintum")) {
    return (
      <FullScreen>
        <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 text-center shadow-lg">
          <ShieldX className="mx-auto text-amber-500" size={36} />
          <h1 className="mt-4 text-lg font-semibold text-foreground">
            moMINTum isn't enabled yet
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            An admin hasn't switched moMINTum on for your account. Ask an
            admin to enable it in Printavo Hub Settings → Module access.
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isRefetching}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              <RefreshCw
                size={14}
                className={isRefetching ? "animate-spin" : ""}
              />
              Check again
            </button>
            <button
              type="button"
              onClick={() => signOut()}
              className="inline-flex items-center gap-2 rounded-md bg-muted px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/80"
            >
              <LogOut size={14} /> Sign out
            </button>
          </div>
        </div>
      </FullScreen>
    );
  }

  return <StaffContext.Provider value={data}>{children}</StaffContext.Provider>;
}
