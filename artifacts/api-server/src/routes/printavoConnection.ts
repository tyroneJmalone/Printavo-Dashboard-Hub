import { Router, type IRouter } from "express";
import { PrintavoClient, probeQuery } from "@workspace/printavo";
import { UpdatePrintavoConnectionBody, GetPrintavoConnectionResponse } from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/requireStaff";
import { connectionCredentials, readConnection, saveConnection, sealToken } from "../lib/printavoConnection";

const router: IRouter = Router();
async function status() {
  const row = await readConnection();
  return GetPrintavoConnectionResponse.parse({
    email: row?.value.email || process.env.PRINTAVO_API_EMAIL || "",
    configured: Boolean((row?.value.email || process.env.PRINTAVO_API_EMAIL) && (row?.value.encryptedToken || process.env.PRINTAVO_API_TOKEN)),
    expiresOn: row?.value.expiresOn ?? null,
    source: row?.value.encryptedToken ? "Hub settings" : "Server settings",
    environment: process.env.REPLIT_DEPLOYMENT === "1" ? "Published app" : "Development preview",
    updatedAt: row?.updatedAt.toISOString() ?? null,
  });
}
router.get("/auth/printavo-connection", requireAdmin, async (_req, res): Promise<void> => {
  try { res.json(await status()); }
  catch { res.status(500).json({ error: "Could not load connection settings" }); }
});
// Serialize saves in this server so overlapping submissions cannot interleave.
let saving = false;
router.put("/auth/printavo-connection", requireAdmin, async (req, res): Promise<void> => {
  const parsed = UpdatePrintavoConnectionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Enter a valid email, token and expiration date" }); return; }
  const { expiresOn } = parsed.data;
  if (expiresOn !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn) ||
    !Number.isFinite(Date.parse(expiresOn)) || new Date(expiresOn).toISOString().slice(0, 10) !== expiresOn)) {
    res.status(400).json({ error: "Enter a valid expiration date" }); return;
  }
  if (saving) { res.status(409).json({ error: "Another connection update is in progress" }); return; }
  saving = true;
  try {
    const row = await readConnection();
    const email = parsed.data.email.trim();
    const replacement = parsed.data.token?.trim();
    const token = replacement || (await connectionCredentials()).token;
    try {
      // Read-only check. Never echo provider errors, which could contain credentials.
      await new PrintavoClient({ email, token }).query(probeQuery());
    } catch {
      res.status(502).json({ error: "Printavo verification failed. Check the email/token or try again later. The existing connection was not changed." });
      return;
    }
    await saveConnection({
      email,
      encryptedToken: replacement ? sealToken(replacement) : row?.value.encryptedToken,
      expiresOn,
      updatedBy: String(req.staff!.id),
    });
    res.json(await status());
  } catch {
    res.status(500).json({ error: "Could not save the connection. Check server encryption configuration and try again." });
  } finally { saving = false; }
});
export default router;
