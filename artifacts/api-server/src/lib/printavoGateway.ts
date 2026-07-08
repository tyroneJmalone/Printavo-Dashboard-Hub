import { PrintavoClient, type PrintavoClientStats } from "@workspace/printavo";

let client: PrintavoClient | null = null;

export function printavoConfigured(): boolean {
  return Boolean(
    process.env["PRINTAVO_API_EMAIL"] && process.env["PRINTAVO_API_TOKEN"],
  );
}

/**
 * The single shared gateway. Every Printavo call in the entire Hub must go
 * through this client so the in-process throttle actually protects the
 * account-wide 10 req/5s limit.
 */
export function getPrintavoClient(): PrintavoClient {
  if (!client) {
    const email = process.env["PRINTAVO_API_EMAIL"];
    const token = process.env["PRINTAVO_API_TOKEN"];
    if (!email || !token) {
      throw new Error(
        "PRINTAVO_API_EMAIL and PRINTAVO_API_TOKEN must be set to talk to Printavo",
      );
    }
    client = new PrintavoClient({ email, token });
  }
  return client;
}

export function printavoClientStats(): PrintavoClientStats | null {
  return client ? client.stats : null;
}
