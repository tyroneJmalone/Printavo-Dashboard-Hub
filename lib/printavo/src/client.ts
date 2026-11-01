import { RequestGate, sleep } from "./throttle";

export const PRINTAVO_ENDPOINT = "https://www.printavo.com/api/v2";

/** ~8 req / 5s. 550ms tripped real 429s on bursts; 620ms is the proven-safe spacing. */
export const MIN_INTERVAL_MS = 620;

/** Cooldown before the single retry after a 429. */
export const RETRY_AFTER_429_MS = 5200;

/**
 * Printavo sporadically returns transient server-side timeouts as GraphQL
 * errors in an HTTP 200 (observed: "Timeout on IDed.id"). Queries are
 * read-only, so re-sending is safe — retry with backoff instead of
 * failing a whole sync run.
 */
export const GRAPHQL_TIMEOUT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

function isTransientTimeout(errors: Array<{ message?: string }>): boolean {
  return errors.every(
    (e) => typeof e.message === "string" && e.message.startsWith("Timeout on"),
  );
}

/** Backoff schedule for transient network errors (ECONNRESET etc). */
export const NETWORK_RETRY_DELAYS_MS = [2000, 6000];

export interface PrintavoClientOptions {
  email: string;
  token: string;
  credentials?: () => Promise<{ email: string; token: string }>;
  endpoint?: string;
  minIntervalMs?: number;
}

export interface PrintavoClientStats {
  requestCount: number;
  retryCount: number;
  errorCount: number;
  lastRequestAt: string | null;
  last429At: string | null;
}

export class PrintavoApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number,
    public readonly graphqlErrors?: unknown[],
    /**
     * Partial `data` returned alongside GraphQL errors (HTTP 200).
     * Printavo's schema declares some fields non-nullable that CAN be
     * null in practice (e.g. PurchaseOrder.vendor after a vendor is
     * deleted); callers that can tolerate the gap may salvage this.
     */
    public readonly partialData?: unknown,
  ) {
    super(message);
    this.name = "PrintavoApiError";
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

interface BufferedResponse {
  status: number;
  ok: boolean;
  bodyText: string;
}

export class PrintavoClient {
  private readonly gate: RequestGate;
  private readonly endpoint: string;
  private readonly email: string;
  private readonly token: string;
  private readonly credentials?: PrintavoClientOptions["credentials"];

  private requestCount = 0;
  private retryCount = 0;
  private errorCount = 0;
  private lastRequestAt: Date | null = null;
  private last429At: Date | null = null;

  constructor(options: PrintavoClientOptions) {
    this.email = options.email;
    this.token = options.token;
    this.credentials = options.credentials;
    this.endpoint = options.endpoint ?? PRINTAVO_ENDPOINT;
    this.gate = new RequestGate(options.minIntervalMs ?? MIN_INTERVAL_MS);
  }

  get stats(): PrintavoClientStats {
    return {
      requestCount: this.requestCount,
      retryCount: this.retryCount,
      errorCount: this.errorCount,
      lastRequestAt: this.lastRequestAt?.toISOString() ?? null,
      last429At: this.last429At?.toISOString() ?? null,
    };
  }

  /** All Printavo traffic must go through this method. */
  query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    return this.gate.schedule(() => this.execute<T>(query, variables, true));
  }

  /**
   * Execute a non-idempotent GraphQL mutation exactly once.
   *
   * A connection drop after Printavo accepts a mutation can look identical to
   * a drop before it accepts it. Retrying in either this client or a caller
   * could create a duplicate quote/order, so writes intentionally get no 429,
   * timeout, or network retry. Callers must persist ambiguous outcomes for
   * operator review.
   */
  mutate<T>(mutation: string, variables: Record<string, unknown> = {}): Promise<T> {
    return this.gate.schedule(() => this.execute<T>(mutation, variables, false));
  }

  private async execute<T>(
    query: string,
    variables: Record<string, unknown>,
    allowRetry: boolean,
  ): Promise<T> {
    for (let timeoutAttempt = 0; ; timeoutAttempt++) {
      let response = allowRetry
        ? await this.postWithNetworkRetry(query, variables)
        : await this.postOnce(query, variables);

      if (response.status === 429) {
        if (!allowRetry) {
          this.last429At = new Date();
          this.errorCount += 1;
          throw new PrintavoApiError(
            "Printavo rate limited a non-idempotent mutation; it was not retried",
            429,
          );
        }
        this.last429At = new Date();
        this.retryCount += 1;
        await sleep(RETRY_AFTER_429_MS);
        response = await this.postWithNetworkRetry(query, variables);
        if (response.status === 429) {
          this.errorCount += 1;
          throw new PrintavoApiError(
            "Printavo rate limit hit twice in a row (429 after cooldown retry)",
            429,
          );
        }
      }

      if (!response.ok) {
        this.errorCount += 1;
        throw new PrintavoApiError(
          `Printavo HTTP ${response.status}: ${response.bodyText.slice(0, 500)}`,
          response.status,
        );
      }

      let body: GraphQLResponse<T>;
      try {
        body = JSON.parse(response.bodyText) as GraphQLResponse<T>;
      } catch {
        this.errorCount += 1;
        throw new PrintavoApiError(
          `Printavo returned invalid JSON: ${response.bodyText.slice(0, 200)}`,
          response.status,
        );
      }

      if (body.errors && body.errors.length > 0) {
        if (
          allowRetry &&
          isTransientTimeout(body.errors) &&
          timeoutAttempt < GRAPHQL_TIMEOUT_RETRY_DELAYS_MS.length
        ) {
          this.retryCount += 1;
          await sleep(GRAPHQL_TIMEOUT_RETRY_DELAYS_MS[timeoutAttempt]);
          continue;
        }
        this.errorCount += 1;
        const messages = body.errors
          .map((e) => e.message ?? JSON.stringify(e))
          .join("; ");
        throw new PrintavoApiError(
          `Printavo GraphQL error: ${messages}`,
          response.status,
          body.errors,
          body.data ?? undefined,
        );
      }

      if (body.data === undefined || body.data === null) {
        this.errorCount += 1;
        throw new PrintavoApiError(
          "Printavo returned no data",
          response.status,
        );
      }

      return body.data;
    }
  }

  /**
   * fetch() (and body streaming) reject with TypeError ("fetch failed" /
   * "terminated") on connection-level failures (ECONNRESET, DNS blips).
   * These are transient — retry with backoff instead of failing the whole
   * sync run. The response body is fully buffered INSIDE the retried unit
   * because connection drops surface during body reads too, not just on
   * the initial fetch. GraphQL queries are read-only, so re-sending after
   * a partial exchange is safe.
   */
  private async postWithNetworkRetry(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<BufferedResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.post(query, variables);
        const bodyText = await response.text();
        return { status: response.status, ok: response.ok, bodyText };
      } catch (err) {
        if (attempt >= NETWORK_RETRY_DELAYS_MS.length) {
          this.errorCount += 1;
          throw err;
        }
        this.retryCount += 1;
        await sleep(NETWORK_RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  private async postOnce(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<BufferedResponse> {
    const response = await this.post(query, variables);
    const bodyText = await response.text();
    return { status: response.status, ok: response.ok, bodyText };
  }

  private async post(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Response> {
    const credentials = this.credentials ? await this.credentials() : { email: this.email, token: this.token };
    this.requestCount += 1;
    this.lastRequestAt = new Date();
    return fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        email: credentials.email,
        token: credentials.token,
      },
      body: JSON.stringify({ query, variables }),
    });
  }
}
