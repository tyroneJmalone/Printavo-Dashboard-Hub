import { Router, type IRouter } from "express";
import { asc, eq } from "drizzle-orm";
import { db as momintumDb, tasksTable, membersTable } from "@workspace/momintum-db";
import { db as hubDb, printavoTaskLinksTable } from "@workspace/db";
import {
  taskCreateMutation,
  taskDeleteMutation,
  accountUsersQuery,
} from "@workspace/printavo";
import { getPrintavoClient, printavoConfigured } from "../lib/printavoGateway";
import { isSyncRunning, type PvTaskNode } from "../printavoTasks/sync";
import { requireAuth } from "./auth";

/**
 * Send-to-Printavo (PT4): create a STANDALONE Printavo calendar task from a
 * moMINTum task and link the pair (origin="momintum"). From then on the
 * existing sync handles two-way completion; content edits after send do NOT
 * propagate (content mirror is printavo-origin only, by design).
 *
 * Constraints (live-verified): Printavo taskCreate REQUIRES dueAt. Recurring
 * tasks are rejected — completing the Printavo copy would respawn a fresh
 * UNLINKED moMINTum occurrence and the link would settle on the old one.
 */

export class SendToPrintavoError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SendToPrintavoError";
  }
}

interface AccountUsersPage {
  account: {
    users: {
      nodes: { id: string; name: string | null; email: string | null }[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

/** Lowercase email → Printavo user id (paged; hard page cap for safety). */
async function findPrintavoUserIdByEmail(
  email: string,
): Promise<string | null> {
  const client = getPrintavoClient();
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const data: AccountUsersPage = await client.query<AccountUsersPage>(
      accountUsersQuery(after),
    );
    const hit = data.account.users.nodes.find(
      (u) => u.email?.trim().toLowerCase() === email,
    );
    if (hit) return hit.id;
    if (!data.account.users.pageInfo.hasNextPage) break;
    after = data.account.users.pageInfo.endCursor;
    if (!after) break;
  }
  return null;
}

export interface SendToPrintavoResult {
  printavoTaskId: string;
  matchedAssignee: boolean;
  assigneeEmail: string | null;
}

/**
 * Core send flow, exported for testability. Throws SendToPrintavoError with
 * an HTTP status + human-readable message for every rejection.
 */
export async function sendMomintumTaskToPrintavo(
  taskId: number,
): Promise<SendToPrintavoResult> {
  if (!printavoConfigured()) {
    throw new SendToPrintavoError(503, "Printavo is not configured");
  }

  const [task] = await momintumDb
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId));
  if (!task || task.deletedAt) {
    throw new SendToPrintavoError(404, "Task not found");
  }
  if (task.completed) {
    throw new SendToPrintavoError(
      400,
      "This task is already completed — only open tasks can be sent to Printavo.",
    );
  }
  if (task.recurrence) {
    throw new SendToPrintavoError(
      400,
      "Recurring tasks can't be sent to Printavo — send a one-off copy instead.",
    );
  }
  if (!task.dueDate) {
    throw new SendToPrintavoError(
      400,
      "Set a due date first — Printavo requires one.",
    );
  }

  const [existing] = await hubDb
    .select()
    .from(printavoTaskLinksTable)
    .where(eq(printavoTaskLinksTable.momintumTaskId, taskId));
  if (existing?.suppressed) {
    throw new SendToPrintavoError(
      409,
      "This task was previously linked to Printavo and can't be re-sent. Duplicate the task and send the copy instead.",
    );
  }
  if (existing) {
    throw new SendToPrintavoError(
      409,
      "This task is already synced with Printavo.",
    );
  }

  // A concurrent sync scan could twin the fresh Printavo task before our
  // link insert lands — refuse while a cycle is running (unique indexes +
  // compensating deletes make the residual race self-healing regardless).
  if (isSyncRunning()) {
    throw new SendToPrintavoError(
      409,
      "A Printavo sync is running — try again in a few seconds.",
    );
  }

  // Resolve the assignee's email → Printavo user (no match → unassigned).
  let assigneeEmail: string | null = null;
  let printavoUserId: string | null = null;
  if (task.assigneeId) {
    const [member] = await momintumDb
      .select()
      .from(membersTable)
      .where(eq(membersTable.id, task.assigneeId))
      .orderBy(asc(membersTable.id))
      .limit(1);
    assigneeEmail = member?.email?.trim().toLowerCase() || null;
    if (assigneeEmail) {
      printavoUserId = await findPrintavoUserIdByEmail(assigneeEmail);
    }
  }

  const client = getPrintavoClient();
  const created = await client.query<{ taskCreate: PvTaskNode }>(
    taskCreateMutation({
      name: task.title,
      dueAt: task.dueDate.toISOString(),
      ...(printavoUserId ? { assignedToId: printavoUserId } : {}),
    }),
  );
  const pv = created.taskCreate;
  if (!pv?.id) {
    throw new SendToPrintavoError(502, "Printavo returned no task");
  }

  // Link the pair. Baseline comes from Printavo's RESPONSE (its normalized
  // echo), not from what we sent — prevents a spurious content-changed hit
  // on the first scan. Crash window: if the insert fails, compensate with
  // taskDelete so no unlinked Printavo task survives.
  try {
    await hubDb.insert(printavoTaskLinksTable).values({
      printavoTaskId: pv.id,
      momintumTaskId: task.id,
      origin: "momintum",
      lastSyncedCompleted: false,
      lastSyncedName: pv.name,
      lastSyncedDueAt: pv.dueAt ? new Date(pv.dueAt) : null,
      lastSyncedAssigneeEmail: pv.assignedTo?.email?.trim().toLowerCase() ?? null,
      lastSeenAt: null,
    });
  } catch (linkErr) {
    try {
      await client.query(taskDeleteMutation(pv.id));
    } catch (deleteErr) {
      throw new SendToPrintavoError(
        500,
        `Linking failed AND cleanup failed — Printavo task ${pv.id} may be orphaned: ${
          deleteErr instanceof Error ? deleteErr.message : String(deleteErr)
        }`,
      );
    }
    throw new SendToPrintavoError(
      500,
      `Linking failed (Printavo task rolled back): ${
        linkErr instanceof Error ? linkErr.message : String(linkErr)
      }`,
    );
  }

  return {
    printavoTaskId: pv.id,
    matchedAssignee: Boolean(pv.assignedTo),
    assigneeEmail,
  };
}

const router: IRouter = Router();

router.get("/tasks/:id/printavo-link", async (req, res): Promise<void> => {
  const taskId = Number(req.params["id"]);
  if (!Number.isInteger(taskId)) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  const [link] = await hubDb
    .select()
    .from(printavoTaskLinksTable)
    .where(eq(printavoTaskLinksTable.momintumTaskId, taskId));
  res.json({
    available: printavoConfigured(),
    linked: Boolean(link && !link.suppressed),
    origin: link && !link.suppressed ? link.origin : null,
    printavoTaskId: link && !link.suppressed ? link.printavoTaskId : null,
    previouslyLinked: Boolean(link?.suppressed),
  });
});

router.post(
  "/tasks/:id/send-to-printavo",
  requireAuth,
  async (req, res): Promise<void> => {
    const taskId = Number(req.params["id"]);
    if (!Number.isInteger(taskId)) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    try {
      const result = await sendMomintumTaskToPrintavo(taskId);
      res.json(result);
    } catch (err) {
      if (err instanceof SendToPrintavoError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(500).json({
        error: err instanceof Error ? err.message : "Send to Printavo failed",
      });
    }
  },
);

export default router;
