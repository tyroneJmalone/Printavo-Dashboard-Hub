/** Settings navigation is independent of the mounted tools so guards run before their hooks. */
export type SettingsGroup = "access" | "connections" | "rules" | "general";
export type SettingsSection = {
  id: string;
  label: string;
  group: SettingsGroup;
  adminOnly?: boolean;
  module?: string;
};

export const settingsSections: readonly SettingsSection[] = [
  { id: "staff-access", label: "Staff Access", group: "access", adminOnly: true },
  { id: "module-access", label: "Module Access", group: "access", adminOnly: true },
  { id: "admin-pin", label: "Admin PIN", group: "access", adminOnly: true },
  { id: "ai-connections", label: "AI Connections", group: "connections", adminOnly: true },
  { id: "knowledge-base", label: "Knowledge Base", group: "connections", module: "knowledge" },
  { id: "email-access", label: "Email Access", group: "connections", adminOnly: true },
  { id: "voice-profiles", label: "Voice Profiles", group: "connections" },
  { id: "email-tracker", label: "Email Tracker Setup", group: "connections", adminOnly: true },
  { id: "print-queue-rules", label: "Print Queue Rules", group: "rules", module: "production" },
  { id: "auto-print", label: "Auto Print", group: "rules", module: "production" },
  { id: "purchasing-status-rules", label: "Purchasing Status Rules", group: "rules", module: "purchasing" },
  { id: "shipping-address", label: "Shipping address", group: "general", module: "purchasing" },
];

const legacySections: Record<string, string> = {
  "/knowledge": "knowledge-base",
  "/ai-connections": "ai-connections",
  "/voice-profiles": "voice-profiles",
  "/email-activity/access": "email-access",
  "/email-activity/settings": "email-tracker",
  "/print-queue-rules": "print-queue-rules",
  "/auto-print": "auto-print",
  "/status-rules": "purchasing-status-rules",
};

export function resolveSettingsSection(search: string): SettingsSection | undefined {
  const params = new URLSearchParams(search);
  return settingsSections.find((item) => item.id === params.get("section"));
}

export function settingsHref(sectionId: string, search = ""): string {
  const section = settingsSections.find((item) => item.id === sectionId);
  if (!section) throw new Error(`Unknown settings section: ${sectionId}`);
  const params = new URLSearchParams(search);
  params.set("group", section.group);
  params.set("section", section.id);
  return `/settings?${params.toString()}`;
}

export function legacySettingsHref(path: string, search = ""): string | undefined {
  const sectionId = legacySections[path];
  return sectionId ? settingsHref(sectionId, search) : undefined;
}

export function canOpenSettingsSection(
  section: SettingsSection,
  role: string,
  enabledModules: readonly string[],
): boolean {
  return (!section.adminOnly || role === "admin") &&
    (!section.module || role === "admin" || enabledModules.includes(section.module));
}