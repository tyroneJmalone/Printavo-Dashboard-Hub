// No Clerk SDK, tokens, or server-side identity changes in this test harness.
export function useStaff() {
  return {
    email: `${localStorage.getItem("test-admin") ?? "admin-a"}@example.invalid`,
    role: localStorage.getItem("test-role") ?? "admin",
    capabilities: [],
    enabledModules: ["production", "dashboard"],
  };
}
export const useClerk = () => ({ signOut: () => { throw new Error("Sign-out is outside this harness"); } });
