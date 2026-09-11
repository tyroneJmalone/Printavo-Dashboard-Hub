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
  type PvOrderNode,
  type Connection,
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
import { sweepProductStatuses, type SweepAgg } from "./productStatusSweep";
import { runExtrasDrip, type ExtrasAgg } from "./extras";
import { refreshReferenceBlobs, type ReferenceBlobsAgg } from "./referenceBlobs";
import { crawlInquiries, type InquiriesAgg } from "./inquiries";
import {
  crawlPaymentRequests,
  type PaymentRequestsAgg,
} from "./paymentRequests";
import { crawlMerch, type MerchAgg } from "./merch";
import {
  crawlThreadSummaries,
  runMessagesDrip,
  reflagRecentThreadMessages,
  type ThreadsAgg,
  type MessagesDripAgg,
} from "./threads";
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

/**
 * Product-status sweep depth (25 invoices/page, newest first).
 * Scheduler polls skim the newest ~250 invoices (~7s of throttled
 * requests); manual "Sync now" digs to legacy PO Builder depth (~1250
 * invoices, ~35-50s) since the user is explicitly asking for freshness.
 */
const SWEEP_PAGES_SCHEDULED = 10;
const SWEEP_PAGES_MANUAL = 50;

/**
 * List-crawl early stop. VISUAL_ID desc is the recency proxy (Printavo
 * has no UPDATED_AT sort), so new orders always surface at the top; the
 * crawl may stop once it has covered a floor of newest pages AND seen K
 * consecutive pages with zero changes. Floors chosen from change_events
 * telemetry (July 2026): ~97% of status changes land within the newest
 * ~400 invoices / ~150 quotes. Deeper edits (old order edited, old
 * quote converted) are caught by the once-a-day FULL list crawl
 * (list_daily watermark, scheduled polls only), so worst-case staleness
 * for deep edits is ~24h.
 */
const LIST_FLOOR_PAGES_INVOICES = 16;
const LIST_FLOOR_PAGES_QUOTES = 6;
const LIST_STOP_UNCHANGED_PAGES = 3;

/**
 * Backup-module extras drip cap per scheduled poll. Each order costs
 * ≥1 throttled API request (~0.62s), so 100 ≈ +65s per poll cycle —
 * the initial ~3.5k-order backlog drains over ~3 hours of polls.
 */
const EXTRAS_PER_POLL = 100;

/**
 * Backup module (B4d) thread budgets. Summary crawl early-stop: the
 * threads list is ordered by lastReceivedMessage recency, so new
 * incoming messages always surface on page 1; floor 2 pages + 2
 * unchanged pages ≈ 4 requests per poll steady-state. The daily full
 * crawl (~340 pages over all ~8.5k threads) catches anything deeper.
 * Messages drip: 50 threads/poll ≈ +35s; the initial ~8.5k-thread
 * backfill drains over ~14h of scheduled polls.
 */
const THREADS_FLOOR_PAGES = 2;
const THREADS_STOP_UNCHANGED_PAGES = 2;
const MESSAGES_PER_POLL = 50;
const WEEKLY_REFRESH_MS = 7 * DAILY_REFRESH_MS;
// Weekly deep re-flag scope: only threads with an incoming message in
// the last N days (Tyler 2026-07-22 — full rescan of all ~8.5k threads
// took ~14h/week; 60 days ≈ a few hundred threads, drains in <1h).
const THREADS_DEEP_ACTIVE_DAYS = 60;

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

interface ListEarlyStop {
  floorPages: number;
  stopAfterUnchangedPages: number;
}

interface ListCrawlResult {
  agg: Agg;
  pages: number;
  earlyStopped: boolean;
}

/**
 * Crawl one order list (invoices or quotes, VISUAL_ID desc) to the seed
 * cutoff, hash-diffing each order. With `earlyStop` set, the crawl may
 * stop early once BOTH (a) `floorPages` pages have been covered and
 * (b) the last `stopAfterUnchangedPages` pages contained zero changed
 * orders. Pass `earlyStop: null` for the daily full-depth crawl.
 */
async function crawlOrderList(
  kind: "invoices" | "quotes",
  cutoff: Date,
  opts: UpsertOpts,
  changedOrders: Array<{ id: string; kind: "invoices" | "quotes" }>,
  earlyStop: ListEarlyStop | null,
): Promise<ListCrawlResult> {
  const client = getPrintavoClient();
  const agg = newAgg();
  let cursor: string | null = null;
  let reachedCutoff = false;
  let pages = 0;
  let consecutiveUnchangedPages = 0;
  let earlyStopped = false;

  for (;;) {
    let page: Connection<PvOrderNode>;
    if (kind === "invoices") {
      const data: InvoicesPage = await client.query<InvoicesPage>(
        invoicesPageQuery({ after: cursor }),
      );
      page = data.invoices;
    } else {
      const data: QuotesPage = await client.query<QuotesPage>(
        quotesPageQuery({ after: cursor }),
      );
      page = data.quotes;
    }
    pages += 1;

    let pageHadChange = false;
    for (const node of page.nodes) {
      const createdAt = dateOrNull(node.timestamps?.createdAt);
      if (createdAt && createdAt < cutoff) {
        reachedCutoff = true;
        break;
      }
      const result = await upsertOrder(
        node,
        kind === "invoices" ? "invoice" : "quote",
        opts,
      );
      addOutcome(agg, result);
      if (result.outcome !== "unchanged") {
        pageHadChange = true;
        changedOrders.push({ id: node.id, kind });
      }
    }

    if (reachedCutoff || !page.pageInfo.hasNextPage) break;
    if (earlyStop) {
      consecutiveUnchangedPages = pageHadChange
        ? 0
        : consecutiveUnchangedPages + 1;
      if (
        pages >= earlyStop.floorPages &&
        consecutiveUnchangedPages >= earlyStop.stopAfterUnchangedPages
      ) {
        earlyStopped = true;
        break;
      }
    }
    cursor = page.pageInfo.endCursor;
  }

  return { agg, pages, earlyStopped };
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
    const isScheduled = trigger === "scheduler";
    const cutoff = new Date(runStart);
    cutoff.setMonth(cutoff.getMonth() - SEED_MONTHS);
    const opts: UpsertOpts = { emitEvents: true, syncRunId: run.id };

    const changedOrders: Array<{ id: string; kind: "invoices" | "quotes" }> =
      [];

    // Detail phase setup. All once-a-day full crawls are gated on
    // isScheduled so a manual "Sync now" NEVER pays a daily-crawl cost
    // (the ~16-min full detail re-crawl would otherwise land on
    // whoever clicks the button at the wrong time). Skipped until the
    // detail backfill has completed once (architect ruling: nightly
    // re-crawl runs INSIDE the poll cycle, never on a separate timer).
    let detailAgg: DetailAgg | null = null;
    let sweepAgg: SweepAgg | null = null;
    const refreshedOrderIds = new Set<string>();
    const detailsWm = await getWatermark("details");
    let detailRecrawlDue = false;
    if (detailsWm) {
      detailAgg = newDetailAgg();
      if (isScheduled) {
        const detailsDailyWm = await getWatermark("details_daily");
        detailRecrawlDue =
          !detailsDailyWm ||
          runStart.getTime() - detailsDailyWm.getTime() > DAILY_REFRESH_MS;
      }
      if (!detailRecrawlDue) {
        // Product-status sweep FIRST: line item productStatus edits never
        // bump the order's updatedAt, so the list-hash crawl misses them.
        // Running the sweep + mismatch refreshes before the list crawls
        // means the Vendor Orders queue is fresh within the first ~40s of
        // a manual sync instead of after the full crawl.
        const sweep = await sweepProductStatuses(
          trigger === "manual" ? SWEEP_PAGES_MANUAL : SWEEP_PAGES_SCHEDULED,
          cutoff,
          logger,
        );
        sweepAgg = sweep.agg;
        for (const id of sweep.mismatchedOrderIds) {
          // force: the sweep proved DB != API for this order, so bypass
          // the detail-hash short-circuit (a drifted DB row with a
          // matching hash would otherwise never be repaired).
          const outcome = await refreshOrderDetail(id, "invoices", detailAgg, logger, {
            force: true,
            syncRunId: run.id,
          });
          // A brand-new order isn't in pv_orders yet (missing_order):
          // leave it out of the dedupe set so the post-crawl refresh
          // loop picks it up after the list crawl creates the row.
          if (outcome !== "missing_order") {
            refreshedOrderIds.add(id);
          }
        }
      }
    }

    // List crawls: early-stop (floor + K unchanged pages) on every poll
    // except the once-a-day full-depth crawl (scheduled polls only),
    // which catches deep edits to old orders.
    const listDailyWm = await getWatermark("list_daily");
    const listFullDue =
      isScheduled &&
      (!listDailyWm ||
        runStart.getTime() - listDailyWm.getTime() > DAILY_REFRESH_MS);
    const invoiceCrawl = await crawlOrderList(
      "invoices",
      cutoff,
      opts,
      changedOrders,
      listFullDue
        ? null
        : {
            floorPages: LIST_FLOOR_PAGES_INVOICES,
            stopAfterUnchangedPages: LIST_STOP_UNCHANGED_PAGES,
          },
    );
    const quoteCrawl = await crawlOrderList(
      "quotes",
      cutoff,
      opts,
      changedOrders,
      listFullDue
        ? null
        : {
            floorPages: LIST_FLOOR_PAGES_QUOTES,
            stopAfterUnchangedPages: LIST_STOP_UNCHANGED_PAGES,
          },
    );
    const invoiceAgg = invoiceCrawl.agg;
    const quoteAgg = quoteCrawl.agg;

    // Order detail (line items / imprints): refetch for orders whose
    // list-level hash changed this poll (sweep-mismatched orders were
    // already refreshed above); once a day (scheduled only) do a FULL
    // detail re-crawl to catch child edits that never bump the order's
    // updatedAt.
    if (detailsWm && detailAgg) {
      if (detailRecrawlDue) {
        await crawlDetailEntity("invoices", cutoff, detailAgg, logger, undefined, {
          syncRunId: run.id,
        });
        await crawlDetailEntity("quotes", cutoff, detailAgg, logger, undefined, {
          syncRunId: run.id,
        });
        await setWatermark("details_daily", runStart);
      } else {
        for (const { id, kind } of changedOrders) {
          if (refreshedOrderIds.has(id)) continue;
          await refreshOrderDetail(id, kind, detailAgg, logger, {
            syncRunId: run.id,
          });
          refreshedOrderIds.add(id);
        }
      }
      await setWatermark("details", runStart);
    }

    let referenceAgg: Agg | null = null;
    let referenceBlobsAgg: ReferenceBlobsAgg | null = null;
    if (isScheduled) {
      const refWm = await getWatermark("reference_daily");
      if (!refWm || runStart.getTime() - refWm.getTime() > DAILY_REFRESH_MS) {
        referenceAgg = await refreshReferenceEntities(opts, logger);
        // B4a: account-level reference blobs ride the same daily sweep.
        referenceBlobsAgg = await refreshReferenceBlobs(logger);
        await setWatermark("reference_daily", runStart);
      }
    }

    // Payments: early-stop crawl each poll; once a day (scheduled only)
    // do a FULL crawl to catch backdated transaction-date edits deep in
    // the list. Skipped entirely until the payments seed has run (no
    // watermark yet).
    let paymentsAgg: PaymentsAgg | null = null;
    const paymentsWm = await getWatermark("payments");
    if (paymentsWm) {
      const paymentsDailyWm = await getWatermark("payments_daily");
      const fullCrawlDue =
        isScheduled &&
        (!paymentsDailyWm ||
          runStart.getTime() - paymentsDailyWm.getTime() > DAILY_REFRESH_MS);
      paymentsAgg = await crawlTransactions(opts, {
        stopOnUnchangedPage: !fullCrawlDue,
        logger,
      });
      await setWatermark("payments", runStart);
      if (fullCrawlDue) {
        await setWatermark("payments_daily", runStart);
      }
    }

    // Backup-module extras drip (scheduled polls only, keeps manual
    // "Sync now" snappy): capture/refresh the per-order extras blob for
    // orders flagged stale by the list crawl or never captured.
    let extrasAgg: ExtrasAgg | null = null;
    if (isScheduled) {
      extrasAgg = await runExtrasDrip(EXTRAS_PER_POLL, logger);
    }

    // The daily full-depth order crawl is already complete at this
    // point — commit its watermark BEFORE the B4 block so a B4 failure
    // can't void ~40 minutes of finished crawl work.
    if (listFullDue) {
      await setWatermark("list_daily", runStart);
    }

    // Backup module B4 (scheduled polls only, keeps manual sync
    // snappy): threads/messages, payment requests every poll with
    // early stop; inquiries + merch daily.
    let threadsAgg: ThreadsAgg | null = null;
    let messagesAgg: MessagesDripAgg | null = null;
    let paymentRequestsAgg: PaymentRequestsAgg | null = null;
    let inquiriesAgg: InquiriesAgg | null = null;
    let merchAgg: MerchAgg | null = null;
    let threadsReflagged: number | null = null;
    if (isScheduled) {
      const threadsDailyWm = await getWatermark("threads_daily");
      const threadsFullDue =
        !threadsDailyWm ||
        runStart.getTime() - threadsDailyWm.getTime() > DAILY_REFRESH_MS;
      threadsAgg = await crawlThreadSummaries(
        threadsFullDue
          ? null
          : {
              floorPages: THREADS_FLOOR_PAGES,
              stopAfterUnchangedPages: THREADS_STOP_UNCHANGED_PAGES,
            },
        logger,
      );
      if (threadsFullDue) {
        await setWatermark("threads_daily", runStart);
      }

      // Weekly deep re-flag: lastReceivedMessage only tracks INCOMING
      // messages, so outgoing-only replies never resurface in the
      // summary crawl. Re-pull messages weekly for threads active in
      // the last THREADS_DEEP_ACTIVE_DAYS (Tyler 2026-07-22: full
      // rescan took ~14h; 60-day scope drains in well under an hour).
      const threadsDeepWm = await getWatermark("threads_deep");
      if (
        !threadsDeepWm ||
        runStart.getTime() - threadsDeepWm.getTime() > WEEKLY_REFRESH_MS
      ) {
        threadsReflagged = await reflagRecentThreadMessages(
          THREADS_DEEP_ACTIVE_DAYS,
        );
        await setWatermark("threads_deep", runStart);
        logger.info(
          { threadsReflagged },
          "Weekly deep re-flag: recently-active thread messages marked stale",
        );
      }

      messagesAgg = await runMessagesDrip(MESSAGES_PER_POLL, logger);

      const prDailyWm = await getWatermark("payment_requests_daily");
      const prFullDue =
        !prDailyWm ||
        runStart.getTime() - prDailyWm.getTime() > DAILY_REFRESH_MS;
      paymentRequestsAgg = await crawlPaymentRequests({
        stopOnUnchangedPage: !prFullDue,
        logger,
      });
      if (prFullDue) {
        await setWatermark("payment_requests_daily", runStart);
      }

      const inquiriesWm = await getWatermark("inquiries_daily");
      if (
        !inquiriesWm ||
        runStart.getTime() - inquiriesWm.getTime() > DAILY_REFRESH_MS
      ) {
        inquiriesAgg = await crawlInquiries(logger);
        await setWatermark("inquiries_daily", runStart);
      }

      const merchWm = await getWatermark("merch_daily");
      if (
        !merchWm ||
        runStart.getTime() - merchWm.getTime() > DAILY_REFRESH_MS
      ) {
        merchAgg = await crawlMerch(logger);
        await setWatermark("merch_daily", runStart);
      }
    }

    await setWatermark("invoices", runStart);
    await setWatermark("quotes", runStart);

    const stats: Record<string, unknown> = {
      trigger,
      invoices: {
        ...invoiceAgg,
        pages: invoiceCrawl.pages,
        earlyStopped: invoiceCrawl.earlyStopped,
      },
      quotes: {
        ...quoteAgg,
        pages: quoteCrawl.pages,
        earlyStopped: quoteCrawl.earlyStopped,
      },
      listFullCrawl: listFullDue,
      ...(referenceAgg ? { reference: referenceAgg } : {}),
      ...(referenceBlobsAgg ? { referenceBlobs: referenceBlobsAgg } : {}),
      ...(paymentsAgg ? { payments: paymentsAgg } : {}),
      ...(detailAgg ? { details: detailAgg } : {}),
      ...(sweepAgg ? { productStatusSweep: sweepAgg } : {}),
      ...(extrasAgg ? { extras: extrasAgg } : {}),
      ...(threadsAgg ? { threads: threadsAgg } : {}),
      ...(messagesAgg ? { messages: messagesAgg } : {}),
      ...(threadsReflagged !== null ? { threadsReflagged } : {}),
      ...(paymentRequestsAgg ? { paymentRequests: paymentRequestsAgg } : {}),
      ...(inquiriesAgg ? { inquiries: inquiriesAgg } : {}),
      ...(merchAgg ? { merch: merchAgg } : {}),
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
