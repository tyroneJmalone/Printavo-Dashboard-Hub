import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { db, appSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// Separate preview and published credentials even when the database is shared.
const key = `printavo_connection_${process.env.REPLIT_DEPLOYMENT === "1" ? "production" : "development"}`;
type Stored = { email: string; encryptedToken?: string; expiresOn: string | null; updatedBy: string };
let configured = Boolean(process.env.PRINTAVO_API_EMAIL && process.env.PRINTAVO_API_TOKEN);
function encryptionKey() {
  if (!process.env.SESSION_SECRET) throw new Error("Connection encryption is not configured");
  return createHash("sha256").update(`hub-printavo:${process.env.SESSION_SECRET}`).digest();
}
export function sealToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(b => b.toString("base64")).join(".");
}
function openToken(value: string) {
  const [iv, tag, data] = value.split(".").map(v => Buffer.from(v, "base64"));
  const cipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8");
}
export async function readConnection() {
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, key));
  return row ? { value: row.value as Stored, updatedAt: row.updatedAt } : null;
}
export async function connectionCredentials() {
  const row = await readConnection();
  const email = row?.value.email || process.env.PRINTAVO_API_EMAIL || "";
  const token = row?.value.encryptedToken ? openToken(row.value.encryptedToken) : process.env.PRINTAVO_API_TOKEN || "";
  configured = Boolean(email && token);
  if (!configured) throw new Error("PRINTAVO_API connection is not configured");
  return { email, token };
}
export async function initializePrintavoConnection() {
  const row = await readConnection();
  configured = Boolean((row?.value.email || process.env.PRINTAVO_API_EMAIL) &&
    (row?.value.encryptedToken || process.env.PRINTAVO_API_TOKEN));
}
export function connectionConfigured() { return configured; }
export async function saveConnection(value: Stored) {
  await db.insert(appSettingsTable).values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSettingsTable.key, set: { value, updatedAt: new Date() } });
  await initializePrintavoConnection();
}
