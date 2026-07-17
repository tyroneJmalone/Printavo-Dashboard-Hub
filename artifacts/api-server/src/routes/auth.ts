import { Router, type IRouter } from "express";

/**
 * Auth/session routes. Mounted AFTER requireStaff, so req.staff is always
 * present here. Sign-out is handled entirely client-side by Clerk.
 */
const router: IRouter = Router();

router.get("/auth/me", (req, res) => {
  const staff = req.staff!;
  res.json({
    email: staff.email,
    role: staff.role,
  });
});

export default router;
