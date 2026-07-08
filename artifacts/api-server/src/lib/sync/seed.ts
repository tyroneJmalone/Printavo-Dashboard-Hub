import type { Logger } from "pino";
import {
  statusesPageQuery,
  customersPageQuery,
  contactsPageQuery,
  quotesPageQuery,
  invoicesPageQuery,
  type StatusesPage,
  type CustomersPage,
  type ContactsPage,
  type QuotesPage,
  type InvoicesPage,
  type PageInfo,
} from "@workspace/printavo";
import { getPrintavoClient, printavoConfigured } from "../printavoGateway";
import { dateOrNull } from "./differ";
import { isSeedActive, isPollActive, setSeedActive } from "./runState";
import {
  createRun,
  findRunningRun,
  completeRun,
  failRun,
  getOrCreateCheckpoint,
  updateCheckpointCursor,
  markCheckpointComplete,
  setWatermark,
  tableCounts,
} from "./state";
import {
  upsertStatus,
  upsertCustomer,
  upsertContact,
  upsertOrder,
  type UpsertOpts,
} from "./upserts";

export const SEED_MONTHS = 12;

const SEED_ENTITIES = [
  "statuses",
  "customers",
  "contacts",
  "quotes",
  "invoices",
] as const;

type SeedEntity = (typeof SEED_ENTITIES)[number];

export { isSeedActive } from "./runState";

export interface SeedStart {
  started: boolean;
  syncRunId: number | null;
  message: string;
}

export async function startOrResumeSeed(logger: Logger): Promise<SeedStart> {
  if (isSeedActive()) {
    return { started: false, syncRunId: null, message: "A seed is already running" };
  }
  if (isPollActive()) {
    return {
      started: false,
      syncRunId: null,
      message: "An incremental poll is running — try again in a moment",
    };
  }
  if (!printavoConfigured()) {
    return {
      started: false,
      syncRunId: null,
      message: "Printavo credentials are not configured yet",
    };
  }
  setSeedActive(true);
  let run;
  let resumed = false;
  try {
    run = await findRunningRun("seed");
    resumed = Boolean(run);
    if (!run) {
      run = await createRun("seed");
    }
  } catch (err) {
    setSeedActive(false);
    throw err;
  }
  const runId = run.id;
  const startedAt = run.startedAt;
  void runSeed(runId, startedAt, logger)
    .catch((err) => {
      logger.error({ err }, "Seed run crashed");
    })
    .finally(() => {
      setSeedActive(false);
    });
  return {
    started: true,
    syncRunId: runId,
    message: resumed
      ? `Resuming interrupted seed run #${runId}`
      : `Seed run #${runId} started (last ${SEED_MONTHS} months)`,
  };
}

async function runSeed(
  runId: number,
  runStartedAt: Date,
  logger: Logger,
): Promise<void> {
  const cutoff = new Date(runStartedAt);
  cutoff.setMonth(cutoff.getMonth() - SEED_MONTHS);
  logger.info(
    { runId, cutoff: cutoff.toISOString() },
    "Seed run starting/resuming",
  );
  try {
    for (const entity of SEED_ENTITIES) {
      await seedEntity(runId, entity, cutoff, logger);
    }
    for (const entity of ["invoices", "quotes", "reference_daily"]) {
      await setWatermark(entity, runStartedAt);
    }
    const counts = await tableCounts();
    await completeRun(runId, { ...counts, cutoff: cutoff.toISOString() });
    logger.info({ runId, counts }, "Seed run completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failRun(runId, message).catch(() => undefined);
    logger.error({ runId, err }, "Seed run failed");
  }
}

async function seedEntity(
  runId: number,
  entity: SeedEntity,
  cutoff: Date,
  logger: Logger,
): Promise<void> {
  const checkpoint = await getOrCreateCheckpoint(runId, entity);
  if (checkpoint.completed) return;

  const client = getPrintavoClient();
  const opts: UpsertOpts = { emitEvents: false, syncRunId: runId };
  let cursor: string | null = checkpoint.cursor ?? null;
  let pages = 0;
  let records = 0;

  for (;;) {
    let pageInfo: PageInfo;
    let reachedCutoff = false;

    switch (entity) {
      case "statuses": {
        const data = await client.query<StatusesPage>(statusesPageQuery(cursor));
        for (const node of data.statuses.nodes) {
          await upsertStatus(node, opts);
          records += 1;
        }
        pageInfo = data.statuses.pageInfo;
        break;
      }
      case "customers": {
        const data = await client.query<CustomersPage>(customersPageQuery(cursor));
        for (const node of data.customers.nodes) {
          await upsertCustomer(node, opts);
          records += 1;
        }
        pageInfo = data.customers.pageInfo;
        break;
      }
      case "contacts": {
        const data = await client.query<ContactsPage>(contactsPageQuery(cursor));
        for (const node of data.contacts.nodes) {
          await upsertContact(node, opts);
          records += 1;
        }
        pageInfo = data.contacts.pageInfo;
        break;
      }
      case "quotes": {
        const data = await client.query<QuotesPage>(
          quotesPageQuery({ after: cursor }),
        );
        for (const node of data.quotes.nodes) {
          const createdAt = dateOrNull(node.timestamps?.createdAt);
          if (createdAt && createdAt < cutoff) {
            reachedCutoff = true;
            break;
          }
          await upsertOrder(node, "quote", opts);
          records += 1;
        }
        pageInfo = data.quotes.pageInfo;
        break;
      }
      case "invoices": {
        const data = await client.query<InvoicesPage>(
          invoicesPageQuery({ after: cursor }),
        );
        for (const node of data.invoices.nodes) {
          const createdAt = dateOrNull(node.timestamps?.createdAt);
          if (createdAt && createdAt < cutoff) {
            reachedCutoff = true;
            break;
          }
          await upsertOrder(node, "invoice", opts);
          records += 1;
        }
        pageInfo = data.invoices.pageInfo;
        break;
      }
    }

    pages += 1;
    cursor = pageInfo.endCursor;
    await updateCheckpointCursor(runId, entity, cursor);

    if (pages % 10 === 0) {
      logger.info({ runId, entity, pages, records }, "Seed progress");
    }
    if (reachedCutoff || !pageInfo.hasNextPage) break;
  }

  await markCheckpointComplete(runId, entity);
  logger.info({ runId, entity, pages, records }, "Seed entity completed");
}
