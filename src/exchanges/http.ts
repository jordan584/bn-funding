import type { VenueId } from '../domain.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const MAX_ERROR_BODY = 500;

export class VenueRequestError extends Error {
  constructor(readonly venue: VenueId, message: string) {
    super(message);
    this.name = 'VenueRequestError';
  }
}

export class VenueTimeoutError extends VenueRequestError {
  constructor(venue: VenueId, method: string, path: string) {
    super(venue, `${venue} request timed out: ${method} ${path}`);
    this.name = 'VenueTimeoutError';
  }
}

export interface PublicJsonClientOptions {
  venue: VenueId;
  baseUrl: URL;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxRetries?: number;
  minRequestIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export class PublicJsonClient {
  private nextRequestAt = 0;
  private pacingTail: Promise<void> = Promise.resolve();
  private readonly venue: VenueId;
  private readonly baseUrl: URL;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly minRequestIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(options: PublicJsonClientOptions) {
    this.venue = options.venue;
    this.baseUrl = options.baseUrl;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = normalizeMaxRetries(options.maxRetries);
    this.minRequestIntervalMs = normalizeInterval(options.minRequestIntervalMs);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  async getJson(path: string, query: Record<string, string> = {}): Promise<unknown> {
    return this.requestJson('GET', path, query, undefined);
  }

  async postJson(path: string, body: unknown): Promise<unknown> {
    return this.requestJson('POST', path, {}, body);
  }

  private async requestJson(
    method: 'GET' | 'POST',
    path: string,
    query: Record<string, string>,
    body: unknown
  ): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    const errorPath = url.pathname;

    for (let retryIndex = 0; ; retryIndex += 1) {
      await this.waitForPacing();
      const signal = AbortSignal.timeout(this.timeoutMs);
      try {
        const response = await this.withTimeout(
          this.fetcher(url, this.requestInit(method, body, signal)),
          signal
        );
        if (response.ok) {
          try {
            return await this.withTimeout(response.json(), signal);
          } catch (error) {
            if (isTimeout(error, signal)) {
              throw error;
            }
            throw new VenueRequestError(
              this.venue,
              `${this.venue} response was not valid JSON: ${method} ${errorPath}`
            );
          }
        }

        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || retryIndex >= this.maxRetries) {
          throw new VenueRequestError(
            this.venue,
            await this.responseErrorMessage(method, errorPath, response, signal)
          );
        }
        await this.sleep(this.retryDelayMs(response, retryIndex));
      } catch (error) {
        if (error instanceof VenueRequestError) {
          throw error;
        }
        if (isTimeout(error, signal)) {
          if (retryIndex >= this.maxRetries) {
            throw new VenueTimeoutError(this.venue, method, errorPath);
          }
          await this.sleep(this.retryDelayMs(undefined, retryIndex));
          continue;
        }
        if (retryIndex >= this.maxRetries) {
          throw new VenueRequestError(
            this.venue,
            `${this.venue} network request failed: ${method} ${errorPath}`
          );
        }
        await this.sleep(this.retryDelayMs(undefined, retryIndex));
      }
    }
  }

  private requestInit(method: 'GET' | 'POST', body: unknown, signal: AbortSignal): RequestInit {
    if (method === 'GET') {
      return { method, signal };
    }
    return {
      method,
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    };
  }

  private async waitForPacing(): Promise<void> {
    let release: () => void;
    const previous = this.pacingTail;
    this.pacingTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const waitMs = Math.max(this.nextRequestAt - this.now(), 0);
      if (waitMs > 0) {
        await this.sleep(waitMs);
      }
      this.nextRequestAt = this.now() + this.minRequestIntervalMs;
    } finally {
      release!();
    }
  }

  private async withTimeout<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      throw signal.reason;
    }
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', abort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        }
      );
    });
  }

  private retryDelayMs(response: Response | undefined, retryIndex: number): number {
    const retryAfter = response?.headers.get('retry-after');
    if (retryAfter !== null && retryAfter !== undefined && retryAfter.trim() !== '') {
      const retryAfterSeconds = Number(retryAfter);
      if (Number.isFinite(retryAfterSeconds)) {
        return retryAfterSeconds * 1_000;
      }
    }
    return Math.min(500 * 2 ** retryIndex + this.random() * 250, 10_000);
  }

  private async responseErrorMessage(
    method: string,
    path: string,
    response: Response,
    signal: AbortSignal
  ): Promise<string> {
    let body = '';
    try {
      body = (await this.withTimeout(response.text(), signal)).slice(0, MAX_ERROR_BODY);
    } catch (error) {
      if (isTimeout(error, signal)) {
        throw error;
      }
      // The status is sufficient to report a failed request.
    }
    const bodySuffix = body === '' ? '' : `: ${body}`;
    return `${this.venue} request failed: ${method} ${path} returned ${response.status}${bodySuffix}`;
  }
}

function normalizeMaxRetries(value: number | undefined): number {
  const requested = value ?? MAX_RETRIES;
  if (!Number.isFinite(requested)) {
    return MAX_RETRIES;
  }
  return Math.min(Math.max(Math.trunc(requested), 0), MAX_RETRIES);
}

function normalizeInterval(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

function isTimeout(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === 'TimeoutError');
}
