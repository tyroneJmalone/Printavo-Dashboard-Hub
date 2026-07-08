import type { Logger } from "pino";
import {
  invoicesPageQuery,
  quotesPageQuery,
  statusesPageQuery,
  customersPageQuery,
  contactsPageQuery,
  type InvoicesPage,
  type QuotesPage,
  type StatusesPage,
  type CustomersPage,
  type ContactsPage,
} from "@workspace/printavo";
import { getPrintavoClient, printavoConfigured } from "../printavoGateway";
import {
  isSeedActive,
  isPollActive,
  isDetailBackfillActive,
  isPaymentsSeedActive,
  setPollActive,
} from "./runState";
import { crawlTransactions, type PaymentsAgg } from "./payments";
import {
  refreshOrderDetail,
  crawlDetailEntity,
  newDetailAgg,
  type DetailAgg,
} from "./detail";
import { dateOrNull } from "./differ";
import { SEED_MONTHS } from "./seed";
import {
  createRun,
  completeRun,
  failRun,
  getWatermark,
  setWatermark,
} from "./state";
import {
  upsertOrder,
  upsertStatus,
  upsertCustomer,
  upsertContact,
  type UpsertOpts,
  type UpsertOutcome,
} from "./upserts";

const DAILY_REFRESH_MS = 24 * 60 * 60 * 1000;

export { isPollActive } from "./runState";

interface Agg {
  seen: number;
  created: number;
  updated: number;
  unchanged: number;
  converted: number;
  events: number;
}

function newAgg(): Agg {
  return { seen: 0, created: 0, updated: 0, unchanged: 0, converted: 0, events: 0 };
}

function addOutcome(agg: Agg, result: UpsertOutcome): void {
  agg.seen += 1;
  agg[result.outcome] += 1;
  agg.events += result.events;
}

export interface PollResultInfo {
  ran: boolean;
  message: string;
  stats: Record<string, unknown> | null;
}

export async function runIncrementalPoll(
  trigger: "scheduler" | "manual",
  logger: Logger,
): Promise<PollResultInfo> {
  if (!printavoConfigured()) {
    return {
      ran: false,
      message: "Printavo credentials are not configured yet",
      stats: null,
    };
  }
  if (isSeedActive()) {
    return { ran: false, message: "Seed is running — poll skipped", stats: null };
  }
  if (isDetailBackfillActive()) {
    return {
      ran: false,
      message: "Detail backfill is running — poll skipped",
      stats: null,
    };
  }
  if (isPaymentsSeedActive()) {
    return {
      ran: false,
      message: "Payments seed is running — poll skipped",
      stats: null,
    };
  }
  if (isPollActive()) {
    return { ran: false, message: "A poll is already running", stats: null };
  }

  setPollActive(true);
  let run;
  try {
    const invoiceWm = await getWatermark("invoices");
    const quoteWm = await getWatermark("quotes");
    if (!invoiceWm || !quoteWm) {
      return {
        ran: false,
        message: "Seed has not completed yet — no watermarks",
        stats: null,
      };
    }
    if (isSeedActive()) {
      return { ran: false, message: "Seed is running — poll skipped", stats: null };
    }

    run = await createRun("incremental");
    const runStart = run.startedAt;
    const cutoff = new Date(runStart);
    cutoff.setMonth(cutoff.getMonth() - SEED_MONTHS);
    const client = getPrintavoClient();
    const opts: UpsertOpts = { emitEvents: true, syncRunId: run.id };

    const changedOrders: Array<{ id: string; kind: "invoices" | "quotes" }> =
      [];

    const invoiceAgg = newAgg();
    let cursor: string | null = null;
    let reachedCutoff = false;
    for (;;) {
      const data: InvoicesPage = await client.query<InvoicesPage>(
        invoicesPageQuery({ after: cursor }),
      );
      for (const node of data.invoices.nodes) {
        const createdAt = dateOrNull(node.timestamps?.createdAt);
        if (createdAt && createdAt < cutoff) {
          reachedCutoff = true;
          break;
        }
        const result = await upsertOrder(node, "invoice", opts);
        addOutcome(invoiceAgg, result);
        if (result.outcome !== "unchanged") {
          changedOrders.push({ id: node.id, kind: "invoices" });
        }
      }
      if (reachedCutoff || !data.invoices.pageInfo.hasNextPage) break;
      cursor = data.invoices.pageInfo.endCursor;
    }

    const quoteAgg = newAgg();
    cursor = null;
    reachedCutoff = false;
    for (;;) {
      const data: QuotesPage = await client.query<QuotesPage>(
        quotesPageQuery({ after: cursor }),
      );
      for (const node of data.quotes.nodes) {
        const createdAt = dateOrNull(node.timestamps?.createdAt);
        if (createdAt && createdAt < cutoff) {
          reachedCutoff = true;
          break;
        }
        const result = await upsertOrder(node, "quote", opts);
        addOutcome(quoteAgg, result);
        if (result.outcome !== "unchanged") {
          changedOrders.push({ id: node.id, kind: "quotes" });
        }
      }
      if (reachedCutoff || !data.quotes.pageInfo.hasNextPage) break;
      cursor = data.quotes.pageInfo.endCursor;
    }

    // Order detail (line items / imprints): refetch for orders whose
    // list-level hash changed this poll; once a day do a FULL detail
    // re-crawl to catch child edits that never bump the order's
    // updatedAt. Skipped until the detail backfill has completed once
    // (architect ruling: nightly re-crawl runs INSIDE the poll cycle,
    // never on a separate timer).
    let detailAgg: DetailAgg | null = null;
    const detailsWm = await getWatermark("details");
    if (detailsWm) {
      detailAgg = newDetailAgg();
      const detailsDailyWm = await getWatermark("details_daily");
      const recrawlDue =
        !detailsDailyWm ||
        runStart.getTime() - detailsDailyWm.getTime() > DAILY_REFRESH_MS;
      if (recrawlDue) {
        await crawlDetailEntity("invoices", cutoff, detailAgg, logger);
        await crawlDetailEntity("quotes", cutoff, detailAgg, logger);
        await setWatermark("details_daily", runStart);
      } else {
        for (const { id, kind } of changedOrders) {
          await refreshOrderDetail(id, kind, detailAgg, logger);
        }
      }
      await setWatermark("details", runStart);
    }

    let referenceAgg: Agg | null = null;
    const refWm = await getWatermark("reference_daily");
    if (!refWm || runStart.getTime() - refWm.getTime() > DAILY_REFRESH_MS) {
      referenceAgg = await refreshReferenceEntities(opts, logger);
      await setWatermark("reference_daily", runStart);
    }

    // Payments: early-stop crawl each poll; once a day do a FULL crawl to
    // catch backdated transaction-date edits deep in the list. Skipped
    // entirely until the payments seed has run (no watermark yet).
    let paymentsAgg: PaymentsAgg | null = null;
    const paymentsWm = await getWatermark("payments");
    if (paymentsWm) {
      const paymentsDailyWm = await getWatermark("payments_daily");
      const fullCrawlDue =
        !paymentsDailyWm ||
        runStart.getTime() - paymentsDailyWm.getTime() > DAILY_REFRESH_MS;
      paymentsAgg = await crawlTransactions(opts, {
        stopOnUnchangedPage: !fullCrawlDue,
        logger,
      });
      await setWatermark("payments", runStart);
      if (fullCrawlDue) {
        await setWatermark("payments_daily", runStart);
      }
    }

    await setWatermark("invoices", runStart);
    await setWatermark("quotes", runStart);

    const stats: Record<string, unknown> = {
      trigger,
      invoices: invoiceAgg,
      quotes: quoteAgg,
      ...(referenceAgg ? { reference: referenceAgg } : {}),
      ...(paymentsAgg ? { payments: paymentsAgg } : {}),
      ...(detailAgg ? { details: detailAgg } : {}),
    };
    await completeRun(run.id, stats);

    const changes =
      invoiceAgg.events +
      quoteAgg.events +
      (referenceAgg?.events ?? 0) +
      (paymentsAgg?.events ?? 0);
    return {
      ran: true,
      message:
        changes > 0
          ? `Poll complete — ${changes} change event(s) recorded`
          : "Poll complete — no changes since last poll",
      stats,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (run) {
      await failRun(run.id, message).catch(() => undefined);
    }
    logger.error({ err, runId: run?.id }, "Incremental poll failed");
    return { ran: false, message: `Poll failed: ${message}`, stats: null };
  } finally {
    setPollActive(false);
  }
}

async function refreshReferenceEntities(
  opts: UpsertOpts,
  logger: Logger,
): Promise<Agg> {
  const client = getPrintavoClient();
  const agg = newAgg();

  let cursor: string | null = null;
  for (;;) {
    const data: StatusesPage = await client.query<StatusesPage>(
      statusesPageQuery(cursor),
    );
    for (const node of data.statuses.nodes) {
      addOutcome(agg, await upsertStatus(node, opts));
    }
    if (!data.statuses.pageInfo.hasNextPage) break;
    cursor = data.statuses.pageInfo.endCursor;
  }

  cursor = null;
  for (;;) {
    const data: CustomersPage = await client.query<CustomersPage>(
      customersPageQuery(cursor),
    );
    for (const node of data.customers.nodes) {
      addOutcome(agg, await upsertCustomer(node, opts));
    }
    if (!data.customers.pageInfo.hasNextPage) break;
    cursor = data.customers.pageInfo.endCursor;
  }

  cursor = null;
  for (;;) {
    const data: ContactsPage = await client.query<ContactsPage>(
      contactsPageQuery(cursor),
    );
    for (const node of data.contacts.nodes) {
      addOutcome(agg, await upsertContact(node, opts));
    }
    if (!data.contacts.pageInfo.hasNextPage) break;
    cursor = data.contacts.pageInfo.endCursor;
  }

  logger.info({ agg }, "Daily reference refresh complete");
  return agg;
}
