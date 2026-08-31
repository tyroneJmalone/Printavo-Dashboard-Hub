import { Router, type IRouter } from "express";
import { UpdateModuleAccessBody } from "@workspace/api-zod";
import { capabilitiesForRole, requireAdmin } from "../middlewares/requireStaff";
import {
  MODULE_DEFS,
  MODULE_KEYS,
  getEnabledModuleKeys,
  setEnabledModuleKeys,
  isValidModuleKey,
} from "../lib/auth/moduleAccess";

/**
 * Auth/session routes. Mounted AFTER requireStaff, so req.staff is always
 * present here. Sign-out is handled entirely client-side by Clerk.
 *
 * Module access (admin-only management): readiness switches deciding which
 * Hub modules non-admin staff can see and use. /auth/me carries the
 * effective list so the sidebar renders from a single fetch.
 */
const router: IRouter = Router();

router.get("/auth/me", async (req, res) => {
  const staff = req.staff!;
  try {
    const enabledModules =
      staff.role === "admin"
        ? [...MODULE_KEYS]
        : [...(await getEnabledModuleKeys())];
    res.json({
      email: staff.email,
      role: staff.role,
      capabilities: capabilitiesForRole(staff.role),
      enabledModules,
    });
  } catch (err) {
    req.log.error({ err }, "auth/me failed");
    res.status(500).json({ error: "Failed to load session" });
  }
});

function moduleList(enabled: Set<string>) {
  return MODULE_DEFS.map((def) => ({
    key: def.key,
    label: def.label,
    group: def.group,
    enabled: enabled.has(def.key),
  }));
}

router.get("/auth/module-access", requireAdmin, async (req, res) => {
  try {
    const enabled = await getEnabledModuleKeys();
    res.json({ modules: moduleList(enabled) });
  } catch (err) {
    req.log.error({ err }, "load module access failed");
    res.status(500).json({ error: "Failed to load module access" });
  }
});

router.put("/auth/module-access", requireAdmin, async (req, res) => {
  try {
    const parsed = UpdateModuleAccessBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid module access payload" });
      return;
    }
    const unknown = parsed.data.enabled.filter((k) => !isValidModuleKey(k));
    if (unknown.length > 0) {
      res.status(400).json({ error: `Unknown module keys: ${unknown.join(", ")}` });
      return;
    }
    const enabled = await setEnabledModuleKeys(parsed.data.enabled);
    req.log.info(
      { enabled: [...enabled], by: req.staff!.email },
      "module access updated",
    );
    res.json({ modules: moduleList(enabled) });
  } catch (err) {
    req.log.error({ err }, "update module access failed");
    res.status(500).json({ error: "Failed to update module access" });
  }
});

export default router;
