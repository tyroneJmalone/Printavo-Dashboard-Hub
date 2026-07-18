import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { useUser } from "@clerk/react";
import { useListMembers, useGetCurrentMember } from "@workspace/api-client-react";
import type { Member } from "@workspace/api-client-react";

interface CurrentUserContextValue {
  currentUser: Member | undefined;
  members: Member[];
  darkMode: boolean;
  toggleDarkMode: () => void;
}

const CurrentUserContext = createContext<CurrentUserContextValue | null>(null);

const DARK_MODE_KEY = "momintum-dark-mode";

export function CurrentUserProvider({ children }: { children: ReactNode }) {
  const { isSignedIn } = useUser();
  const { data: members } = useListMembers();
  const { data: currentMember } = useGetCurrentMember({
    query: { enabled: !!isSignedIn, queryKey: ["current-member"] },
  });
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const stored = localStorage.getItem(DARK_MODE_KEY);
    return stored === null ? true : stored === "true";
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
    localStorage.setItem(DARK_MODE_KEY, String(darkMode));
  }, [darkMode]);

  return (
    <CurrentUserContext.Provider
      value={{
        currentUser: currentMember,
        members: members ?? [],
        darkMode,
        toggleDarkMode: () => setDarkMode((d) => !d),
      }}
    >
      {children}
    </CurrentUserContext.Provider>
  );
}

const FALLBACK_CTX: CurrentUserContextValue = {
  currentUser: undefined,
  members: [],
  darkMode: false,
  toggleDarkMode: () => {},
};

export function useCurrentUser() {
  const ctx = useContext(CurrentUserContext);
  return ctx ?? FALLBACK_CTX;
}
