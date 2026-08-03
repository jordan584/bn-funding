import type { GoogleChatMessage } from '../domain.js';
import { log } from '../logger.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ERROR_BODY_LENGTH = 500;

export interface GoogleChatClientOptions {
  webhookUrl: URL;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export class GoogleChatRequestError extends Error {
  readonly retryable = false;
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GoogleChatRequestError';
    this.status = status;
  }
}

export class GoogleChatTimeoutError extends Error {
  readonly retryable = false;
  readonly ambiguous = true;

  constructor() {
    super('Google Chat request timed out; delivery status is ambiguous');
    this.name = 'GoogleChatTimeoutError';
  }
}

export class GoogleChatClient {
  private readonly webhookUrl: URL;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: GoogleChatClientOptions) {
    this.webhookUrl = options.webhookUrl;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async send(message: GoogleChatMessage): Promise<void> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await this.fetcher(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(message),
        signal
      });
      if (response.ok) {
        return;
      }

      const error = new GoogleChatRequestError(
        await this.responseErrorMessage(response),
        response.status
      );
      log('error', 'google_chat_request_failed', { error });
      throw error;
    } catch (error) {
      if (error instanceof GoogleChatRequestError) {
        throw error;
      }
      if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
        const timeoutError = new GoogleChatTimeoutError();
        log('error', 'google_chat_request_timed_out', { error: timeoutError });
        throw timeoutError;
      }

      const requestError = new GoogleChatRequestError('Google Chat network request failed');
      log('error', 'google_chat_request_failed', { error: requestError });
      throw requestError;
    }
  }

  private async responseErrorMessage(response: Response): Promise<string> {
    let body = '';
    try {
      body = (await response.text()).slice(0, MAX_ERROR_BODY_LENGTH);
    } catch {
      // The HTTP status still communicates the failed request class.
    }
    return body === ''
      ? `Google Chat request failed: POST returned ${response.status}`
      : `Google Chat request failed: POST returned ${response.status}: ${body}`;
  }
}
