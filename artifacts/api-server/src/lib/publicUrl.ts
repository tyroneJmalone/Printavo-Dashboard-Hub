/**
 * Base URL for links that must be reachable from OUTSIDE this workspace
 * (e.g. the PO HTML that Printavo fetches after productionFileCreate).
 *
 * REPLIT_DOMAINS (set in deployments) wins over REPLIT_DEV_DOMAIN so pushes
 * from production never hand Printavo a dev URL that dies when the
 * workspace sleeps.
 */
export function publicBaseUrl(): string {
  const domain =
    process.env.REPLIT_DOMAINS?.split(",")[0]?.trim() ||
    process.env.REPLIT_DEV_DOMAIN?.trim();
  if (!domain) {
    throw new Error(
      "No public domain configured (REPLIT_DOMAINS / REPLIT_DEV_DOMAIN)",
    );
  }
  return `https://${domain}`;
}

/**
 * Public, token-secured URL for a PO's printable HTML.
 *
 * The trailing filename segment is ignored by the route — it exists only so
 * Printavo names the attached production file after the PO number instead of
 * a junk name derived from the bare token URL ("convert").
 */
export function publicPoHtmlUrl(htmlToken: string, poNumber: string): string {
  const fileName = `${poNumber.replace(/[^A-Za-z0-9._-]+/g, "-")}-PO.html`;
  return `${publicBaseUrl()}/api/purchasing/po-html/${htmlToken}/${fileName}`;
}
