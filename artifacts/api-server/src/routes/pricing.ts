import { Router, type IRouter } from "express";
import { UpsertDecorationMatrixBody } from "@workspace/api-zod";
import {
  listDecorationMatrices,
  upsertDecorationMatrix,
  deleteDecorationMatrix,
  type UpsertMatrixInput,
} from "../lib/pricing/matrices";

const router: IRouter = Router();

router.get("/pricing/matrices", (req, res) => {
  listDecorationMatrices()
    .then((matrices) => res.json({ matrices }))
    .catch((err) => {
      req.log.error({ err }, "Decoration matrix list failed");
      res.status(500).json({ error: "Failed to list matrices" });
    });
});

router.post("/pricing/matrices", (req, res) => {
  const parsed = UpsertDecorationMatrixBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid matrix" });
    return;
  }
  upsertDecorationMatrix(parsed.data as UpsertMatrixInput)
    .then((result) => {
      if (result.status === "invalid") {
        res.status(400).json({ error: result.message });
        return;
      }
      res.json(result.matrix);
    })
    .catch((err) => {
      req.log.error({ err }, "Decoration matrix upsert failed");
      res.status(500).json({ error: "Failed to save matrix" });
    });
});

router.delete("/pricing/matrices/:id", (req, res) => {
  deleteDecorationMatrix(req.params.id)
    .then((outcome) => {
      if (outcome === "not_found") {
        res.status(404).json({ error: "Matrix not found" });
        return;
      }
      res.status(204).end();
    })
    .catch((err) => {
      req.log.error({ err }, "Decoration matrix delete failed");
      res.status(500).json({ error: "Failed to delete matrix" });
    });
});

export default router;
