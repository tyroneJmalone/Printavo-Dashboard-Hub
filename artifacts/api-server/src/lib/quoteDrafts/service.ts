import {
  aiQuoteDraftsTable,
  db,
  decorationMatricesTable,
  pvContactsTable,
  pvCustomersTable,
  type AiQuoteCustomerCandidate,
  type AiQuoteDecoration,
  type AiQuoteDraft,
  type AiQuoteDraftData,
  type AiQuoteGarment,
  type AiQuoteProductOption,
} from "@workspace/db";
import {
  PrintavoApiError,
  quoteCreateMutation,
  toLineItemSizeEnum,
} from "@workspace/printavo";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getPrintavoClient } from "../printavoGateway";
import { listDecorationMatrices } from "../pricing/matrices";
import { productSearch } from "../purchasing/productFinder";
import { extractQuotePrompt } from "./extract";

export class QuoteDraftValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteDraftValidationError";
  }
}

export class QuoteDraftConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteDraftConflictError";
  }
}

function isDefinitiveGraphqlValidationRejection(
  err: unknown,
): err is PrintavoApiError {
  if (
    !(err instanceof PrintavoApiError) ||
    err.httpStatus !== 200 ||
    err.partialData !== undefined ||
    !err.graphqlErrors?.length
  ) {
    return false;
  }
  return err.graphqlErrors.every((graphqlError) => {
    if (!graphqlError || typeof graphqlError !== "object") return false;
    const message = (graphqlError as { message?: unknown }).message;
    return (
      typeof message === "string" &&
      /^InputObject '.+' doesn't accept argument '.+'$/.test(message)
    );
  });
}

function compactWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/\b(company|corporation|incorporated)\b/g, "co")
    .replace(/\b(brewing)\b/g, "brew")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function matchScore(query: string, candidate: string): number {
  const queryWords = compactWords(query);
  const companyWords = compactWords(candidate);
  const q = queryWords.join("");
  const c = companyWords.join("");
  if (q === c) return 100;
  const intersection = queryWords.filter((word) => companyWords.includes(word)).length;
  const union = new Set([...queryWords, ...companyWords]).size;
  const jaccard = union > 0 ? intersection / union : 0;
  const containment = q.includes(c) || c.includes(q) ? 0.25 : 0;
  return jaccard + containment;
}

function containsAllTerms(value: string, terms: string[]): boolean {
  const words = compactWords(value);
  return terms.every((term) => words.some((word) => word.includes(term)));
}

function customerTextSearch(terms: string[], operator: "&" | "|") {
  const query = terms.map((term) => `${term}:*`).join(` ${operator} `);
  return sql<boolean>`to_tsvector('simple', coalesce(${pvCustomersTable.companyName}, '')) @@ to_tsquery('simple', ${query})`;
}

function contactTextSearch(terms: string[], operator: "&" | "|") {
  const query = terms.map((term) => `${term}:*`).join(` ${operator} `);
  return sql<boolean>`to_tsvector('simple', coalesce(${pvContactsTable.fullName}, '') || ' ' || coalesce(${pvContactsTable.email}, '')) @@ to_tsquery('simple', ${query})`;
}

type QuoteCustomerRow = {
  customerId: string;
  companyName: string | null;
  primaryContactId: string | null;
};

type QuoteContactRow = {
  contactId: string;
  contactName: string | null;
  contactEmail: string | null;
  customerId: string | null;
};

type QuoteCustomerGroup = {
  customerId: string;
  companyName: string;
  primaryContactId: string | null;
  contacts: Array<{
    contactId: string;
    contactName: string | null;
    contactEmail: string | null;
  }>;
};

async function findCustomers(
  customerQuery: string,
  contactQuery: string | null = null,
): Promise<AiQuoteCustomerCandidate[]> {
  const companyTerms = compactWords(customerQuery)
    .filter((term) => term.length >= 2)
    .slice(0, 4);
  const contactTerms = compactWords(contactQuery ?? "")
    .filter((term) => term.length >= 2)
    .slice(0, 4);
  if (companyTerms.length === 0 && contactTerms.length === 0) return [];
  let customerRows: QuoteCustomerRow[] = [];
  let contactRows: QuoteContactRow[] = [];
  if (companyTerms.length > 0) {
    customerRows = await db
      .select({
        customerId: pvCustomersTable.printavoId,
        companyName: pvCustomersTable.companyName,
        primaryContactId: pvCustomersTable.primaryContactId,
      })
      .from(pvCustomersTable)
      .where(customerTextSearch(companyTerms, "&"))
      .limit(100);
    if (customerRows.length > 0 && contactTerms.length > 0) {
      const customerIds = customerRows.map((customer) => customer.customerId);
      const primaryContactIds = customerRows
        .map((customer) => customer.primaryContactId)
        .filter((id): id is string => Boolean(id));
      const relationFilters = [
        inArray(pvContactsTable.customerId, customerIds),
        ...(primaryContactIds.length > 0
          ? [inArray(pvContactsTable.printavoId, primaryContactIds)]
          : []),
      ];
      contactRows = await db
        .select({
          contactId: pvContactsTable.printavoId,
          contactName: pvContactsTable.fullName,
          contactEmail: pvContactsTable.email,
          customerId: pvContactsTable.customerId,
        })
        .from(pvContactsTable)
        .where(
          and(
            or(...relationFilters),
            contactTextSearch(contactTerms, "&"),
          ),
        )
        .orderBy(pvContactsTable.printavoId)
        .limit(100);
    } else if (customerRows.length > 0) {
      const primaryContactIds = customerRows
        .map((customer) => customer.primaryContactId)
        .filter((id): id is string => Boolean(id));
      if (primaryContactIds.length > 0) {
        contactRows = await db
          .select({
            contactId: pvContactsTable.printavoId,
            contactName: pvContactsTable.fullName,
            contactEmail: pvContactsTable.email,
            customerId: pvContactsTable.customerId,
          })
          .from(pvContactsTable)
          .where(inArray(pvContactsTable.printavoId, primaryContactIds));
      }
    }
  } else {
    contactRows = await db
      .select({
        contactId: pvContactsTable.printavoId,
        contactName: pvContactsTable.fullName,
        contactEmail: pvContactsTable.email,
        customerId: pvContactsTable.customerId,
      })
      .from(pvContactsTable)
      .where(contactTextSearch(contactTerms, "&"))
      .orderBy(pvContactsTable.printavoId)
      .limit(100);
    const directCustomerIds = contactRows
      .map((contact) => contact.customerId)
      .filter((id): id is string => Boolean(id));
    const contactIds = contactRows.map((contact) => contact.contactId);
    const ownershipFilters = [
      ...(directCustomerIds.length > 0
        ? [inArray(pvCustomersTable.printavoId, directCustomerIds)]
        : []),
      ...(contactIds.length > 0
        ? [inArray(pvCustomersTable.primaryContactId, contactIds)]
        : []),
    ];
    if (ownershipFilters.length > 0) {
      customerRows = await db
        .select({
          customerId: pvCustomersTable.printavoId,
          companyName: pvCustomersTable.companyName,
          primaryContactId: pvCustomersTable.primaryContactId,
        })
        .from(pvCustomersTable)
        .where(or(...ownershipFilters))
        .limit(100);
    }
  }
  const grouped = new Map<string, QuoteCustomerGroup>();
  for (const customer of customerRows) {
    const group: QuoteCustomerGroup = {
      customerId: customer.customerId,
      companyName: customer.companyName ?? "Unnamed customer",
      primaryContactId: customer.primaryContactId,
      contacts: [],
    };
    for (const contact of contactRows) {
      const belongs =
        contact.customerId === customer.customerId ||
        contact.contactId === customer.primaryContactId;
      if (
        belongs &&
        !group.contacts.some(
          (existing) => existing.contactId === contact.contactId,
        )
      ) {
      group.contacts.push({
          contactId: contact.contactId,
          contactName: contact.contactName,
          contactEmail: contact.contactEmail,
      });
    }
    }
    grouped.set(customer.customerId, group);
  }

  return [...grouped.values()]
    .map((group) => {
      const companyScore = customerQuery
        ? matchScore(customerQuery, group.companyName)
        : 0;
      const contacts = group.contacts
        .map((contact) => ({
          ...contact,
          score: contactQuery
            ? Math.max(
                matchScore(contactQuery, contact.contactName ?? ""),
                matchScore(contactQuery, contact.contactEmail ?? ""),
              )
            : 0,
        }))
        .sort((a, b) => b.score - a.score);
      const matchedContact =
        contactQuery
          ? (contacts[0]?.score ?? 0) >= 0.35
            ? contacts[0]
            : null
          : contacts.find(
                (contact) => contact.contactId === group.primaryContactId,
              ) ?? contacts[0] ?? null;
      const contactScore = contactQuery ? contacts[0]?.score ?? 0 : 0;
      const companyMatches = !customerQuery || companyScore >= 0.35;
      const contactMatches = !contactQuery || contactScore >= 0.35;
      const exact =
        (!customerQuery || companyScore >= 99) &&
        (!contactQuery || contactScore >= 99);
      return {
        candidate: {
          customerId: group.customerId,
          companyName: group.companyName,
          contactId: matchedContact?.contactId ?? null,
          contactName: matchedContact?.contactName ?? null,
          contactEmail: matchedContact?.contactEmail ?? null,
          matchType: exact ? "exact" as const : "possible" as const,
        },
        companyMatches,
        contactMatches,
        score: customerQuery
          ? companyScore * 10 + contactScore
          : contactScore,
      };
    })
    .filter(({ companyMatches, contactMatches }) =>
      customerQuery ? companyMatches : contactMatches,
    )
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.candidate.companyName.localeCompare(b.candidate.companyName),
    )
    .slice(0, 10)
    .map(({ candidate }) => candidate);
}

export async function searchQuoteCustomers(
  query: string,
): Promise<AiQuoteCustomerCandidate[]> {
  const terms = compactWords(query)
    .filter((term) => term.length >= 2)
    .slice(0, 6);
  if (terms.length === 0) return [];
  const companyHits = await db
    .select({
      customerId: pvCustomersTable.printavoId,
      companyName: pvCustomersTable.companyName,
      primaryContactId: pvCustomersTable.primaryContactId,
    })
    .from(pvCustomersTable)
    .where(customerTextSearch(terms, "|"))
    .orderBy(pvCustomersTable.printavoId)
    .limit(80);
  const contactHits = await db
    .select({
      contactId: pvContactsTable.printavoId,
      contactName: pvContactsTable.fullName,
      contactEmail: pvContactsTable.email,
      customerId: pvContactsTable.customerId,
    })
    .from(pvContactsTable)
    .where(contactTextSearch(terms, "|"))
    .orderBy(pvContactsTable.printavoId)
    .limit(120);
  const customerIds = new Set([
    ...companyHits.map((customer) => customer.customerId),
    ...contactHits
      .map((contact) => contact.customerId)
      .filter((id): id is string => Boolean(id)),
  ]);
  const contactIds = contactHits.map((contact) => contact.contactId);
  const customerFilters = [
    ...(customerIds.size > 0
      ? [inArray(pvCustomersTable.printavoId, [...customerIds])]
      : []),
    ...(contactIds.length > 0
      ? [inArray(pvCustomersTable.primaryContactId, contactIds)]
      : []),
  ];
  if (customerFilters.length === 0) return [];
  const customers = await db
    .select({
      customerId: pvCustomersTable.printavoId,
      companyName: pvCustomersTable.companyName,
      primaryContactId: pvCustomersTable.primaryContactId,
    })
    .from(pvCustomersTable)
    .where(or(...customerFilters))
    .orderBy(pvCustomersTable.printavoId)
    .limit(100);
  const primaryContactIds = customers
    .map((customer) => customer.primaryContactId)
    .filter((id): id is string => Boolean(id));
  const primaryContacts: QuoteContactRow[] =
    primaryContactIds.length > 0
      ? await db
          .select({
            contactId: pvContactsTable.printavoId,
            contactName: pvContactsTable.fullName,
            contactEmail: pvContactsTable.email,
            customerId: pvContactsTable.customerId,
          })
          .from(pvContactsTable)
          .where(inArray(pvContactsTable.printavoId, primaryContactIds))
      : [];
  const contacts = [...contactHits, ...primaryContacts].filter(
    (contact, index, all) =>
      all.findIndex((candidate) => candidate.contactId === contact.contactId) ===
      index,
  );
  const rows = customers.flatMap((customer) => {
    const matchingContacts = contacts.filter(
      (contact) =>
        contact.customerId === customer.customerId ||
        contact.contactId === customer.primaryContactId,
    );
    const pairs = matchingContacts.length > 0 ? matchingContacts : [null];
    return pairs.map((contact) => ({
      customerId: customer.customerId,
      companyName: customer.companyName,
      contactId: contact?.contactId ?? null,
      contactName: contact?.contactName ?? null,
      contactEmail: contact?.contactEmail ?? null,
    }));
  });

  const seen = new Set<string>();
  return rows
    .filter((row) =>
      containsAllTerms(
        [row.companyName, row.contactName, row.contactEmail]
          .filter(Boolean)
          .join(" "),
        terms,
      ),
    )
    .map((row) => {
      const companyName = row.companyName ?? "Unnamed customer";
      const combined = [companyName, row.contactName, row.contactEmail]
        .filter(Boolean)
        .join(" ");
      const score = Math.max(
        matchScore(query, companyName),
        matchScore(query, row.contactName ?? ""),
        matchScore(query, row.contactEmail ?? ""),
        matchScore(query, combined),
      );
      return {
        score,
        candidate: {
          customerId: row.customerId,
          companyName,
          contactId: row.contactId ?? null,
          contactName: row.contactName ?? null,
          contactEmail: row.contactEmail ?? null,
          matchType: score >= 99 ? "exact" as const : "possible" as const,
        },
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.candidate.companyName.localeCompare(b.candidate.companyName),
    )
    .filter(({ candidate }) => {
      const key = `${candidate.customerId}:${candidate.contactId ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20)
    .map(({ candidate }) => candidate);
}

function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase().replace(/[^a-z0-9]/g, "") ===
    b.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeProductOptions(
  search: Awaited<ReturnType<typeof productSearch>>,
): AiQuoteProductOption[] {
  return search.vendors
    .filter(({ lookup }) => lookup.found && lookup.styleName)
    .map(({ lookup }) => ({
      vendor: lookup.vendor,
      matchType: lookup.matchType === "exact" ? "exact" : "closest",
      styleName: lookup.styleName!,
      brand: lookup.brand,
      title: lookup.title,
      image: lookup.styleImage,
      colors: lookup.colors.map((color) => ({
        name: color.colorName,
        image: color.productImage ?? color.swatchImage,
        sizes: color.sizes.map((size) => ({
          size: size.size,
          cost: size.cost,
          salePrice: size.salePrice,
          inventoryTotal: size.inventoryTotal,
        })),
      })),
    }));
}

function effectiveSizeCost(
  size: { cost: number | null; salePrice: number | null },
): number | null {
  return size.salePrice ?? size.cost;
}

function autoSelectProduct(
  garment: Pick<AiQuoteGarment, "color" | "sizes">,
  options: AiQuoteProductOption[],
): AiQuoteGarment["selectedProduct"] {
  const selections = options.flatMap((option) => {
    const color = option.colors.find((candidate) => sameText(candidate.name, garment.color));
    if (!color) return [];
    const costs = garment.sizes.map((requested) => {
      const offer = color.sizes.find((size) => sameText(size.size, requested.size));
      return offer ? effectiveSizeCost(offer) : null;
    });
    if (costs.some((cost) => cost === null)) return [];
    return [{
      vendor: option.vendor,
      styleName: option.styleName,
      brand: option.brand,
      title: option.title,
      color: color.name,
      garmentCost: Math.max(...(costs as number[])),
      image: color.image ?? option.image,
      rank: option.matchType === "exact" ? 0 : 1,
    }];
  });
  selections.sort((a, b) => a.rank - b.rank || a.garmentCost - b.garmentCost);
  const best = selections[0];
  if (!best) return null;
  const { rank: _rank, ...selected } = best;
  return selected;
}

function autoMatrix(
  decoration: Pick<
    AiQuoteDecoration,
    "location" | "method" | "colorCount" | "details"
  >,
  index: number,
  matrices: Awaited<ReturnType<typeof listDecorationMatrices>>,
): Pick<AiQuoteDecoration, "matrixId" | "matrixColumnIndex"> {
  const method = decoration.method.toLowerCase();
  let matrix = null;
  if (method.includes("screen") || method.includes("print")) {
    const target = index === 0 ? "1stprintloc" : "addnlprintloc";
    matrix = matrices.find((candidate) =>
      candidate.name.toLowerCase().replace(/\s+/g, "").includes(target),
    ) ?? null;
  } else if (method.includes("embro")) {
    matrix = matrices.find((candidate) =>
      candidate.name.toLowerCase().includes("embro"),
    ) ?? null;
  }
  if (!matrix) return { matrixId: null, matrixColumnIndex: null };

  let columnIndex: number | null = null;
  if (decoration.colorCount !== null) {
    const target = `${decoration.colorCount}color`;
    const found = matrix.data.xValues.findIndex(
      (column) => column.label.toLowerCase().replace(/\s+/g, "") === target,
    );
    if (found >= 0) columnIndex = found;
  }
  return { matrixId: matrix.id, matrixColumnIndex: columnIndex };
}

function resolveBreakCost(
  breaks: Array<{ qty: number; decorationCost: number }>,
  quantity: number,
): number {
  const sorted = [...breaks].sort((a, b) => a.qty - b.qty);
  let resolved = sorted[0]?.decorationCost ?? 0;
  for (const priceBreak of sorted) {
    if (priceBreak.qty > quantity) break;
    resolved = priceBreak.decorationCost;
  }
  return resolved;
}

async function verifySelectedCustomer(
  selected: AiQuoteCustomerCandidate | null,
): Promise<AiQuoteCustomerCandidate | null> {
  if (!selected) return null;
  const [customer] = await db
    .select({
      customerId: pvCustomersTable.printavoId,
      companyName: pvCustomersTable.companyName,
      primaryContactId: pvCustomersTable.primaryContactId,
    })
    .from(pvCustomersTable)
    .where(eq(pvCustomersTable.printavoId, selected.customerId))
    .limit(1);
  if (!customer) {
    throw new QuoteDraftValidationError(
      "The selected customer no longer exists in the Printavo mirror.",
    );
  }
  if (!selected.contactId) {
    return {
      customerId: customer.customerId,
      companyName: customer.companyName ?? "Unnamed customer",
      contactId: null,
      contactName: null,
      contactEmail: null,
      matchType: selected.matchType,
    };
  }
  const [contact] = await db
    .select({
      contactId: pvContactsTable.printavoId,
      contactName: pvContactsTable.fullName,
      contactEmail: pvContactsTable.email,
      customerId: pvContactsTable.customerId,
    })
    .from(pvContactsTable)
    .where(eq(pvContactsTable.printavoId, selected.contactId))
    .limit(1);
  if (
    !contact ||
    (contact.customerId !== customer.customerId &&
      customer.primaryContactId !== contact.contactId)
  ) {
    throw new QuoteDraftValidationError(
      "The selected contact does not belong to the selected Printavo customer.",
    );
  }
  return {
    customerId: customer.customerId,
    companyName: customer.companyName ?? "Unnamed customer",
    contactId: contact.contactId,
    contactName: contact.contactName,
    contactEmail: contact.contactEmail,
    matchType: selected.matchType,
  };
}

async function verifyGarment(
  garment: AiQuoteGarment,
): Promise<AiQuoteGarment> {
  let options: AiQuoteProductOption[];
  try {
    options = normalizeProductOptions(await productSearch(garment.style));
  } catch {
    throw new QuoteDraftValidationError(
      `${garment.style}: vendor product data could not be verified. Try saving again.`,
    );
  }
  if (!garment.selectedProduct) {
    return { ...garment, productOptions: options, selectedProduct: null };
  }
  const option = options.find(
    (candidate) =>
      candidate.vendor === garment.selectedProduct?.vendor &&
      sameText(candidate.styleName, garment.selectedProduct.styleName),
  );
  if (!option) {
    throw new QuoteDraftValidationError(
      `${garment.style}: the selected vendor product is no longer a verified search result.`,
    );
  }
  const color = option.colors.find((candidate) =>
    sameText(candidate.name, garment.selectedProduct!.color),
  );
  if (!color) {
    throw new QuoteDraftValidationError(
      `${garment.style}: ${garment.selectedProduct.color} is not a verified vendor color.`,
    );
  }
  const costs = garment.sizes.map((requested) => {
    const offer = color.sizes.find((size) => sameText(size.size, requested.size));
    return offer ? effectiveSizeCost(offer) : null;
  });
  if (costs.some((cost) => cost === null)) {
    throw new QuoteDraftValidationError(
      `${garment.style}: cost data is missing for one or more requested sizes in ${color.name}.`,
    );
  }
  return {
    ...garment,
    brand: option.brand,
    productOptions: options,
    selectedProduct: {
      vendor: option.vendor,
      styleName: option.styleName,
      brand: option.brand,
      title: option.title,
      color: color.name,
      garmentCost: Math.max(...(costs as number[])),
      image: color.image ?? option.image,
    },
  };
}

function removeResolvedUncertainties(
  uncertainties: string[],
  garments: AiQuoteGarment[],
): string[] {
  return uncertainties.filter((uncertainty) => {
    const brandMatch = uncertainty.match(
      /^brand for style\s+(.+?)\s+was not specified\.?$/i,
    );
    if (!brandMatch) return true;
    return !garments.some(
      (garment) =>
        Boolean(garment.selectedProduct?.brand?.trim()) &&
        sameText(garment.style, brandMatch[1]),
    );
  });
}

async function recalculateDraft(input: AiQuoteDraftData): Promise<AiQuoteDraftData> {
  const [matrices, customerCandidates, selectedCustomer, garments] =
    await Promise.all([
      listDecorationMatrices(),
      findCustomers(input.customerQuery, input.contactQuery ?? null),
      verifySelectedCustomer(input.selectedCustomer),
      Promise.all(input.garments.map(verifyGarment)),
    ]);
  const warnings: string[] = [];
  if (!selectedCustomer) warnings.push("Select a verified Printavo customer.");
  else if (!selectedCustomer.contactId) {
    warnings.push("The selected customer has no primary Printavo contact.");
  }
  if (!input.dueDate) warnings.push("Set a customer due date.");

  const matrixById = new Map(matrices.map((matrix) => [matrix.id, matrix]));
  for (const garment of garments) {
    if (!garment.selectedProduct) {
      warnings.push(`${garment.style}: select a verified vendor product and color.`);
    }
    if (garment.sizes.reduce((sum, size) => sum + size.quantity, 0) <= 0) {
      warnings.push(`${garment.style}: enter at least one item.`);
    }
  }
  for (const decoration of input.decorations) {
    const matrix = decoration.matrixId ? matrixById.get(decoration.matrixId) : null;
    const column =
      matrix && decoration.matrixColumnIndex !== null
        ? matrix.data.xValues[decoration.matrixColumnIndex]
        : null;
    if (!column) {
      warnings.push(
        `${decoration.location}: select a verified pricing matrix and column.`,
      );
    }
  }

  const pricing = garments.flatMap((garment) => {
    if (!garment.selectedProduct) return [];
    const quantity = garment.sizes.reduce((sum, size) => sum + size.quantity, 0);
    if (quantity <= 0) return [];
    let decorationCost = 0;
    for (const decoration of input.decorations) {
      if (!decoration.matrixId || decoration.matrixColumnIndex === null) return [];
      const matrix = matrixById.get(decoration.matrixId);
      const column = matrix?.data.xValues[decoration.matrixColumnIndex];
      if (!column) return [];
      decorationCost += resolveBreakCost(column.breaks, quantity);
    }
    const baseCost = garment.selectedProduct.garmentCost * input.markup;
    const unitPrice = baseCost + decorationCost;
    return [{
      garmentId: garment.id,
      quantity,
      garmentCost: garment.selectedProduct.garmentCost,
      garmentMarkup: baseCost - garment.selectedProduct.garmentCost,
      decorationCost,
      unitPrice,
      total: unitPrice * quantity,
    }];
  });

  const currentCandidates = selectedCustomer &&
    !customerCandidates.some(
      (candidate) =>
        candidate.customerId === selectedCustomer.customerId &&
        candidate.contactId === selectedCustomer.contactId,
    )
    ? [selectedCustomer, ...customerCandidates].slice(0, 10)
    : customerCandidates;
  return {
    ...input,
    customerQuery: input.customerQuery ?? "",
    contactQuery: input.contactQuery ?? null,
    dueDate: input.dueDate?.slice(0, 10) ?? null,
    customerCandidates: currentCandidates,
    selectedCustomer,
    garments,
    pricing,
    uncertainties: removeResolvedUncertainties(input.uncertainties, garments),
    warnings,
  };
}

export function quoteDraftDto(row: AiQuoteDraft) {
  return {
    id: row.id,
    status: row.status,
    revision: row.revision,
    prompt: row.prompt,
    draft: row.draft,
    createdByEmail: row.createdByEmail,
    printavoQuoteId: row.printavoQuoteId,
    printavoVisualId: row.printavoVisualId,
    printavoCreatedAt: row.printavoCreatedAt?.toISOString() ?? null,
    createAttemptedAt: row.createAttemptedAt?.toISOString() ?? null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function interpretAndCreateDraft(
  prompt: string,
  createdByEmail: string | null,
) {
  const extracted = await extractQuotePrompt(prompt);
  const [customerCandidates, matrices, productResults] = await Promise.all([
    findCustomers(
      extracted.companyCustomerName ?? "",
      extracted.contactName,
    ),
    listDecorationMatrices(),
    Promise.all(
      extracted.garments.map((garment) =>
        productSearch(garment.style).catch(() => null),
      ),
    ),
  ]);
  const exactCustomers = customerCandidates.filter((candidate) => candidate.matchType === "exact");
  const selectedCustomer = exactCustomers.length === 1 ? exactCustomers[0] : null;

  const garments: AiQuoteGarment[] = extracted.garments.map((garment, index) => {
    const options = productResults[index]
      ? normalizeProductOptions(productResults[index]!)
      : [];
    const base: AiQuoteGarment = {
      id: randomUUID(),
      ...garment,
      productOptions: options,
      selectedProduct: null,
    };
    base.selectedProduct = autoSelectProduct(base, options);
    base.brand = base.selectedProduct?.brand ?? base.brand;
    return base;
  });
  const decorations: AiQuoteDecoration[] = extracted.decorations.map(
    (decoration, index) => ({
      id: randomUUID(),
      ...decoration,
      ...autoMatrix(decoration, index, matrices),
    }),
  );
  const initial: AiQuoteDraftData = {
    customerQuery: extracted.companyCustomerName ?? "",
    contactQuery: extracted.contactName,
    customerCandidates,
    selectedCustomer,
    nickname:
      extracted.nickname ??
      `${extracted.companyCustomerName ?? extracted.contactName ?? "New quote"} — ${garments[0]?.style ?? "Quote"}`,
    dueDate: extracted.dueDate,
    markup: 1.75,
    customerNote: extracted.customerNote,
    productionNote: extracted.productionNote,
    garments,
    decorations,
    pricing: [],
    uncertainties: extracted.uncertainties,
    warnings: [],
  };
  const draft = await recalculateDraft(initial);
  const [created] = await db
    .insert(aiQuoteDraftsTable)
    .values({ prompt, draft, createdByEmail })
    .returning();
  return quoteDraftDto(created);
}

export async function listQuoteDrafts() {
  await recoverStaleCreatingDrafts();
  const rows = await db
    .select()
    .from(aiQuoteDraftsTable)
    .orderBy(desc(aiQuoteDraftsTable.createdAt))
    .limit(50);
  return rows.map(quoteDraftDto);
}

export async function getQuoteDraft(id: string) {
  await recoverStaleCreatingDrafts();
  const [row] = await db
    .select()
    .from(aiQuoteDraftsTable)
    .where(eq(aiQuoteDraftsTable.id, id))
    .limit(1);
  return row ? quoteDraftDto(row) : null;
}

export async function updateQuoteDraft(
  id: string,
  draft: AiQuoteDraftData,
  expectedRevision: number,
) {
  const recalculated = await recalculateDraft(draft);
  const [updated] = await db
    .update(aiQuoteDraftsTable)
    .set({
      draft: recalculated,
      revision: sql`${aiQuoteDraftsTable.revision} + 1`,
      error: null,
    })
    .where(
      and(
        eq(aiQuoteDraftsTable.id, id),
        eq(aiQuoteDraftsTable.status, "draft"),
        eq(aiQuoteDraftsTable.revision, expectedRevision),
      ),
    )
    .returning();
  if (updated) return quoteDraftDto(updated);
  const existing = await getQuoteDraft(id);
  if (!existing) return null;
  if (existing.status === "draft") {
    throw new QuoteDraftConflictError(
      "This draft changed after you opened it. Reload and review the latest revision before saving.",
    );
  }
  throw new QuoteDraftConflictError(
    "This draft can no longer be edited because Printavo creation has already started.",
  );
}

const CREATING_STALE_MS = 10 * 60 * 1_000;

async function recoverStaleCreatingDrafts(): Promise<void> {
  const cutoff = new Date(Date.now() - CREATING_STALE_MS);
  await db
    .update(aiQuoteDraftsTable)
    .set({
      status: "unknown",
      error:
        "Creation was still in progress when the server stopped reporting. Do not retry automatically. Verify Printavo for this customer and nickname.",
    })
    .where(
      and(
        eq(aiQuoteDraftsTable.status, "creating"),
        lt(aiQuoteDraftsTable.createAttemptedAt, cutoff),
      ),
    );
}

function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

function trustedSnapshot(draft: AiQuoteDraftData): string {
  return canonicalJson({
    customer: draft.selectedCustomer,
    dueDate: draft.dueDate,
    nickname: draft.nickname,
    markup: draft.markup,
    garments: draft.garments.map((garment) => ({
      id: garment.id,
      style: garment.style,
      sizes: garment.sizes,
      selectedProduct: garment.selectedProduct,
    })),
    decorations: draft.decorations.map((decoration) => ({
      id: decoration.id,
      location: decoration.location,
      method: decoration.method,
      colorCount: decoration.colorCount,
      details: decoration.details,
      matrixId: decoration.matrixId,
      matrixColumnIndex: decoration.matrixColumnIndex,
    })),
    pricing: draft.pricing,
  });
}

function newYorkDueAt(date: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(`${date}T12:00:00Z`));
  const zone = parts.find((part) => part.type === "timeZoneName")?.value;
  const match = zone?.match(/^GMT([+-]\d{2}:\d{2})$/);
  if (!match) {
    throw new QuoteDraftValidationError(
      "Could not resolve the America/New_York due-time offset.",
    );
  }
  return `${date}T17:00:00${match[1]}`;
}

function assertCreateReady(draft: AiQuoteDraftData): void {
  if (!draft.selectedCustomer?.contactId) {
    throw new QuoteDraftValidationError(
      "Select a verified Printavo customer with a primary contact.",
    );
  }
  if (!draft.dueDate) {
    throw new QuoteDraftValidationError("Set a customer due date.");
  }
  if (!draft.nickname.trim()) {
    throw new QuoteDraftValidationError("Enter a quote nickname.");
  }
  if (draft.warnings.length > 0) {
    throw new QuoteDraftValidationError(
      `Resolve all review warnings first: ${draft.warnings[0]}`,
    );
  }
  if (draft.pricing.length !== draft.garments.length) {
    throw new QuoteDraftValidationError(
      "Trusted pricing is incomplete. Save the draft again before creating the quote.",
    );
  }
  for (const garment of draft.garments) {
    if (!garment.selectedProduct) {
      throw new QuoteDraftValidationError(
        `${garment.style} does not have a verified product selection.`,
      );
    }
    for (const size of garment.sizes) {
      if (!toLineItemSizeEnum(size.size)) {
        throw new QuoteDraftValidationError(
          `${size.size} is not a Printavo-supported size.`,
        );
      }
    }
  }
}

export async function createPrintavoQuote(id: string, expectedRevision: number) {
  await recoverStaleCreatingDrafts();
  const [preflight] = await db
    .select()
    .from(aiQuoteDraftsTable)
    .where(eq(aiQuoteDraftsTable.id, id))
    .limit(1);
  if (!preflight) return null;
  if (preflight.status !== "draft") {
    throw new QuoteDraftConflictError(
      preflight.status === "created"
        ? "This draft has already created a Printavo quote."
        : "This draft has already attempted Printavo creation. Verify Printavo before taking any further action.",
    );
  }
  if (preflight.revision !== expectedRevision) {
    throw new QuoteDraftConflictError(
      "This draft changed after you reviewed it. Reload and review the latest revision before creating a quote.",
    );
  }
  const freshDraft = await recalculateDraft(preflight.draft);
  assertCreateReady(freshDraft);
  if (trustedSnapshot(freshDraft) !== trustedSnapshot(preflight.draft)) {
    throw new QuoteDraftConflictError(
      "Verified customer, vendor cost, product, or pricing data changed. Save and review the refreshed draft before creating a quote.",
    );
  }

  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(aiQuoteDraftsTable)
      .where(eq(aiQuoteDraftsTable.id, id))
      .for("update")
      .limit(1);
    if (!row) return null;
    if (row.status !== "draft") {
      throw new QuoteDraftConflictError(
        row.status === "created"
          ? "This draft has already created a Printavo quote."
          : "This draft has already attempted Printavo creation. Verify Printavo before taking any further action.",
      );
    }
    if (row.revision !== expectedRevision) {
      throw new QuoteDraftConflictError(
        "This draft changed after you reviewed it. Reload and review the latest revision before creating a quote.",
      );
    }
    const [updated] = await tx
      .update(aiQuoteDraftsTable)
      .set({
        status: "creating",
        draft: freshDraft,
        createAttemptedAt: new Date(),
        error: null,
      })
      .where(
        and(
          eq(aiQuoteDraftsTable.id, id),
          eq(aiQuoteDraftsTable.status, "draft"),
          eq(aiQuoteDraftsTable.revision, expectedRevision),
        ),
      )
      .returning();
    return updated;
  });
  if (!claimed) return null;

  const draft = claimed.draft;
  const productionNote = [
    draft.productionNote,
    draft.decorations
      .map((decoration) =>
        [
          decoration.location,
          decoration.method,
          decoration.colorCount ? `${decoration.colorCount} color` : null,
          decoration.details,
        ]
          .filter(Boolean)
          .join(" — "),
      )
      .join("\n"),
    `Created from Hub AI quote draft ${claimed.id}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const mutation = quoteCreateMutation({
    contactId: draft.selectedCustomer!.contactId!,
    customerDueAt: draft.dueDate!,
    dueAt: newYorkDueAt(draft.dueDate!),
    nickname: draft.nickname,
    customerNote: draft.customerNote,
    productionNote,
    lineItemGroups: draft.garments.map((garment, index) => {
      const pricing = draft.pricing.find((line) => line.garmentId === garment.id)!;
      return {
        position: index + 1,
        lineItems: [{
          position: 1,
          itemNumber: garment.selectedProduct!.styleName,
          description:
            garment.selectedProduct!.title ??
            garment.description ??
            garment.selectedProduct!.styleName,
          color: garment.selectedProduct!.color,
          price: pricing.unitPrice,
          markupPercentage: draft.markup * 100,
          sizes: garment.sizes.map((size) => ({
            size: toLineItemSizeEnum(size.size)!,
            count: size.quantity,
          })),
        }],
        imprints: draft.decorations.map((decoration) => ({
          details: [
            decoration.location,
            decoration.method,
            decoration.colorCount ? `${decoration.colorCount} color` : null,
            decoration.details,
          ]
            .filter(Boolean)
            .join(" — "),
        })),
      };
    }),
  });

  try {
    const result = await getPrintavoClient().mutate<{
      quoteCreate: { id: string; visualId: number };
    }>(mutation);
    const [updated] = await db
      .update(aiQuoteDraftsTable)
      .set({
        status: "created",
        printavoQuoteId: result.quoteCreate.id,
        printavoVisualId: result.quoteCreate.visualId,
        printavoCreatedAt: new Date(),
        error: null,
      })
      .where(
        and(
          eq(aiQuoteDraftsTable.id, id),
          eq(aiQuoteDraftsTable.status, "creating"),
        ),
      )
      .returning();
    if (!updated) {
      throw new Error(
        `Printavo quote ${result.quoteCreate.visualId} was created, but the local draft result could not be saved.`,
      );
    }
    return quoteDraftDto(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown Printavo error";
    if (isDefinitiveGraphqlValidationRejection(err)) {
      const [released] = await db
        .update(aiQuoteDraftsTable)
        .set({
          status: "draft",
          createAttemptedAt: null,
          error: null,
        })
        .where(
          and(
            eq(aiQuoteDraftsTable.id, id),
            eq(aiQuoteDraftsTable.status, "creating"),
          ),
        )
        .returning({ id: aiQuoteDraftsTable.id });
      if (!released) {
        throw new QuoteDraftConflictError(
          "Printavo rejected the request before creation, but the draft lock could not be released. Verify the draft before trying again.",
        );
      }
      throw new QuoteDraftValidationError(
        "Printavo rejected the request before creating a quote. The draft remains editable; reload it before trying again.",
      );
    }
    await db
      .update(aiQuoteDraftsTable)
      .set({
        status: "unknown",
        error:
          "Printavo creation returned an uncertain result. Do not retry automatically. Verify Printavo for this customer and nickname. " +
          message.slice(0, 1_000),
      })
      .where(
        and(
          eq(aiQuoteDraftsTable.id, id),
          eq(aiQuoteDraftsTable.status, "creating"),
        ),
      );
    throw new QuoteDraftConflictError(
      "Printavo returned an uncertain result. The draft is locked to prevent a duplicate; verify Printavo manually.",
    );
  }
}