import { Router } from "express";
import { db, appSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { GetVendorShippingTermsResponse, SetVendorShippingTermsBody } from "@workspace/api-zod";
import { requireValidAdminPin } from "../lib/auth/adminPin";

const router = Router();
const path = "/purchasing/shipping-terms/:vendor";
const validDate = (value: string) => {
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
};

router.get(path, async (req, res): Promise<void> => {
  if (!["sanmar", "ss"].includes(String(req.params.vendor))) {
    res.status(400).json({ error: "Unsupported vendor" }); return;
  }
  const [row] = await db.select().from(appSettingsTable)
    .where(eq(appSettingsTable.key, `vendor_shipping_terms:${req.params.vendor}`));
  // Invalid stored contracts are errors, never treated as verified eligibility.
  res.json(GetVendorShippingTermsResponse.parse(row?.value ?? { terms: null, recordedAt: null }));
});

router.put(path, async (req, res): Promise<void> => {
  if (!["sanmar", "ss"].includes(String(req.params.vendor))) {
    res.status(400).json({ error: "Unsupported vendor" }); return;
  }
  const parsed = SetVendorShippingTermsBody.safeParse(req.body);
  if (!parsed.success || !parsed.data.confirmed) {
    res.status(400).json({ error: "Valid terms and explicit account confirmation required" }); return;
  }
  const { terms, adminPin } = parsed.data;
  const today = new Date().toISOString().slice(0, 10);
  if (terms && (!terms.accountLabel.trim() || !terms.evidence.trim() ||
      !validDate(terms.verifiedOn) || !validDate(terms.validThrough) ||
      terms.verifiedOn > today || terms.validThrough < today ||
      terms.validThrough < terms.verifiedOn ||
      terms.excludedBrands.concat(terms.excludedStyles).some(s => !s.trim()))) {
    res.status(400).json({ error: "Provide account evidence and valid confirmation/review dates. Confirmation cannot be in the future and review date cannot be in the past." }); return;
  }
  if (!await requireValidAdminPin(req, res, adminPin, "vendor shipping terms")) return;
  const value = { terms, recordedAt: new Date().toISOString() };
  await db.insert(appSettingsTable).values({ key: `vendor_shipping_terms:${req.params.vendor}`, value })
    .onConflictDoUpdate({ target: appSettingsTable.key, set: { value, updatedAt: new Date() } });
  res.json(value);
});

export default router;
