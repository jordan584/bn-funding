import { createHash } from 'node:crypto';

import type { ScheduledSlot } from '../domain.js';
import type { FundingReportImage } from '../image/funding-report.js';

const API_ORIGIN = 'https://api.github.com';
const RAW_ORIGIN = 'https://raw.githubusercontent.com';
const MAX_ERROR_BODY_LENGTH = 500;

export interface PublishedFundingImages {
  first: string;
  second: string;
}

export interface GitHubImagePublisherOptions {
  token: string;
  repository: string;
  branch: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export class GitHubImagePublishError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GitHubImagePublishError';
  }
}

function encodePath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function contentVersion(png: Buffer): string {
  return createHash('sha256').update(png).digest('hex').slice(0, 12);
}

function safeBranch(value: string): boolean {
  return value.length > 0
    && value.length <= 200
    && /^[A-Za-z0-9._/-]+$/u.test(value)
    && !value.startsWith('/')
    && !value.endsWith('/')
    && !value.includes('..')
    && !value.includes('//');
}

function redactSecrets(value: string): string {
  return value
    .replace(/github_pat_[A-Za-z0-9_]+/gu, '[REDACTED]')
    .replace(/ghp_[A-Za-z0-9]+/gu, '[REDACTED]');
}

export class GitHubImagePublisher {
  private readonly owner: string;
  private readonly repo: string;
  private readonly token: string;
  private readonly branch: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: GitHubImagePublisherOptions) {
    const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(options.repository);
    if (match === null) {
      throw new Error('GITHUB_REPOSITORY must use owner/repository format');
    }
    if (!safeBranch(options.branch)) {
      throw new Error('GITHUB_IMAGE_BRANCH contains unsupported characters');
    }
    this.owner = match[1]!;
    this.repo = match[2]!;
    this.token = options.token;
    this.branch = options.branch;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async publish(
    images: readonly FundingReportImage[],
    slot: ScheduledSlot
  ): Promise<PublishedFundingImages> {
    if (images.length !== 2 || images[0]?.range !== '1-10' || images[1]?.range !== '11-20') {
      throw new Error('GitHub image publication requires ordered 1-10 and 11-20 images');
    }
    await this.ensureBranch();
    const paths = images.map((image) => this.imagePath(slot, image.range));
    for (const [index, image] of images.entries()) {
      await this.upload(paths[index]!, image.png);
    }
    return {
      first: this.rawUrl(paths[0]!, images[0]!.png),
      second: this.rawUrl(paths[1]!, images[1]!.png)
    };
  }

  private imagePath(slot: ScheduledSlot, range: FundingReportImage['range']): string {
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(slot.scheduledAtMs);
    const [year, month, day] = date.split('-');
    return `reports/${year}/${month}/${day}/${slot.key}-top-${range}.png`;
  }

  private rawUrl(path: string, png: Buffer): string {
    const rawUrl = `${RAW_ORIGIN}/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/${encodePath(this.branch)}/${encodePath(path)}`;
    return `${rawUrl}?v=${contentVersion(png)}`;
  }

  private async ensureBranch(): Promise<void> {
    const branchResponse = await this.request(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/ref/heads/${encodeURIComponent(this.branch)}`,
      { allowNotFound: true }
    );
    if (branchResponse !== undefined) return;

    const repository = await this.requestJson<{ default_branch?: unknown }>(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`
    );
    if (typeof repository.default_branch !== 'string' || repository.default_branch === '') {
      throw new GitHubImagePublishError('GitHub repository has no default branch');
    }
    const source = await this.requestJson<{ object?: { sha?: unknown } }>(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/ref/heads/${encodeURIComponent(repository.default_branch)}`
    );
    const sha = source.object?.sha;
    if (typeof sha !== 'string' || sha === '') {
      throw new GitHubImagePublishError('GitHub default branch response has no commit SHA');
    }
    await this.request(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/refs`,
      {
        method: 'POST',
        body: { ref: `refs/heads/${this.branch}`, sha }
      }
    );
  }

  private async upload(path: string, png: Buffer): Promise<void> {
    const endpoint = `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${encodePath(path)}`;
    const current = await this.request(endpoint, {
      query: { ref: this.branch },
      allowNotFound: true
    });
    let sha: string | undefined;
    if (current !== undefined) {
      const body = await this.parseJson<{ sha?: unknown }>(current);
      if (typeof body.sha !== 'string' || body.sha === '') {
        throw new GitHubImagePublishError('GitHub existing image response has no content SHA');
      }
      sha = body.sha;
    }
    await this.request(endpoint, {
      method: 'PUT',
      body: {
        message: `publish funding report ${path.split('/').at(-1) ?? path}`,
        content: png.toString('base64'),
        branch: this.branch,
        ...(sha === undefined ? {} : { sha })
      }
    });
  }

  private async requestJson<T>(path: string): Promise<T> {
    const response = await this.request(path);
    if (response === undefined) throw new Error('unreachable');
    return this.parseJson<T>(response);
  }

  private async parseJson<T>(response: Response): Promise<T> {
    try {
      return await response.json() as T;
    } catch {
      throw new GitHubImagePublishError('GitHub API returned malformed JSON', response.status);
    }
  }

  private async request(path: string, options: {
    method?: 'GET' | 'POST' | 'PUT';
    body?: Record<string, unknown>;
    query?: Record<string, string>;
    allowNotFound?: boolean;
  } = {}): Promise<Response | undefined> {
    const url = new URL(`${API_ORIGIN}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: options.method ?? 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new GitHubImagePublishError('GitHub API network request failed');
    }
    if (response.ok) return response;
    if (options.allowNotFound === true && response.status === 404) return undefined;
    let detail = '';
    try {
      detail = redactSecrets(await response.text()).slice(0, MAX_ERROR_BODY_LENGTH);
    } catch {
      // Status still identifies the failure class.
    }
    throw new GitHubImagePublishError(
      detail === ''
        ? `GitHub API request failed with status ${response.status}`
        : `GitHub API request failed with status ${response.status}: ${detail}`,
      response.status
    );
  }
}
