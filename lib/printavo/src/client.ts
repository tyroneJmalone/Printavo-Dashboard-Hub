import { RequestGate, sleep } from "./throttle";

export const PRINTAVO_ENDPOINT = "https://www.printavo.com/api/v2";

/** ~8 req / 5s. 550ms tripped real 429s on bursts; 620ms is the proven-safe spacing. */
export const MIN_INTERVAL_MS = 620;

/** Cooldown before the single retry after a 429. */
export const RETRY_AFTER_429_MS = 5200;

export interface PrintavoClientOptions {
  email: string;
  token: string;
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
  ) {
    super(message);
    this.name = "PrintavoApiError";
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

export class PrintavoClient {
  private readonly gate: RequestGate;
  private readonly endpoint: string;
  private readonly email: string;
  private readonly token: string;

  private requestCount = 0;
  private retryCount = 0;
  private errorCount = 0;
  private lastRequestAt: Date | null = null;
  private last429At: Date | null = null;

  constructor(options: PrintavoClientOptions) {
    this.email = options.email;
    this.token = options.token;
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
    return this.gate.schedule(() => this.execute<T>(query, variables));
  }

  private async execute<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    let response = await this.post(query, variables);

    if (response.status === 429) {
      this.last429At = new Date();
      this.retryCount += 1;
      await sleep(RETRY_AFTER_429_MS);
      response = await this.post(query, variables);
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
      const bodyText = await response.text().catch(() => "");
      throw new PrintavoApiError(
        `Printavo HTTP ${response.status}: ${bodyText.slice(0, 500)}`,
        response.status,
      );
    }

    const body = (await response.json()) as GraphQLResponse<T>;

    if (body.errors && body.errors.length > 0) {
      this.errorCount += 1;
      const messages = body.errors
        .map((e) => e.message ?? JSON.stringify(e))
        .join("; ");
      throw new PrintavoApiError(
        `Printavo GraphQL error: ${messages}`,
        response.status,
        body.errors,
      );
    }

    if (body.data === undefined || body.data === null) {
      this.errorCount += 1;
      throw new PrintavoApiError("Printavo returned no data", response.status);
    }

    return body.data;
  }

  private async post(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Response> {
    this.requestCount += 1;
    this.lastRequestAt = new Date();
    return fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        email: this.email,
        token: this.token,
      },
      body: JSON.stringify({ query, variables }),
    });
  }
}
