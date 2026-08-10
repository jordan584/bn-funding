import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BinanceVenueAdapter } from '../../src/binance/adapter.js';
import { BitgetClient } from '../../src/bitget/client.js';
import { BybitClient } from '../../src/bybit/client.js';
import { GoogleChatClient } from '../../src/chat/client.js';
import type { GoogleChatMessage, Logger, ScheduledSlot } from '../../src/domain.js';
import { HyperliquidClient } from '../../src/hyperliquid/client.js';
import { renderFundingReportImages, type FundingReportImage } from '../../src/image/funding-report.js';
import { runFundingJob } from '../../src/job.js';
import { OkxClient } from '../../src/okx/client.js';
import { FileRunStateStore } from '../../src/state/store.js';
import { AS_OF, DAY, HOUR, contract, interval, premium } from '../helpers/fixtures.js';

const slot: ScheduledSlot = { key: '2026-08-03T16', scheduledAtMs: AS_OF };
const assets = Array.from({ length: 20 }, (_, index) => `ASSET${String(index + 1).padStart(2, '0')}`);
const symbols = assets.map((asset) => `${asset}USDT`);

interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
}

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function requestBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  return body;
}

function assetIndex(asset: string): number {
  const index = assets.indexOf(asset);
  if (index < 0) throw new Error(`Unknown test asset ${asset}`);
  return index;
}

function nextRate(asset: string): string {
  return `0.000${String(20 - assetIndex(asset)).padStart(3, '0')}`;
}

function okxEnvelope(data: unknown): unknown {
  return { code: '0', msg: '', data };
}

function bybitEnvelope(result: unknown): unknown {
  return { retCode: 0, retMsg: 'OK', result, time: AS_OF };
}

function bitgetEnvelope(data: unknown): unknown {
  return { code: '00000', msg: 'success', requestTime: AS_OF, data };
}

test('runs all five production adapters through local HTTP, sends once, then skips the duplicate slot', async (t) => {
  const routeCalls: RecordedRequest[] = [];
  const webhookPayloads: GoogleChatMessage[] = [];
  let stateFile = '';
  let stateExistedWhenWebhookReceived: boolean | undefined;

  const server = createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      const rawBody = request.method === 'POST' ? await requestBody(request) : '';
      const body: unknown = rawBody === '' ? undefined : JSON.parse(rawBody);
      routeCalls.push({
        method: request.method ?? 'GET',
        path: requestUrl.pathname,
        query: Object.fromEntries(requestUrl.searchParams),
        ...(body === undefined ? {} : { body })
      });

      switch (requestUrl.pathname) {
        case '/fapi/v1/time':
          json(response, { serverTime: AS_OF });
          return;
        case '/fapi/v1/exchangeInfo':
          json(response, { symbols: symbols.map((symbol) => contract(symbol)) });
          return;
        case '/fapi/v1/premiumIndex':
          json(response, symbols.map((symbol) => premium(symbol, nextRate(symbol.replace(/USDT$/, '')))));
          return;
        case '/fapi/v1/fundingInfo':
          json(response, symbols.map((symbol) => interval(symbol, 8)));
          return;
        case '/fapi/v1/fundingRate': {
          const symbol = requestUrl.searchParams.get('symbol');
          if (symbol === null) break;
          json(response, [{
            symbol,
            fundingRate: '0.000001',
            fundingTime: Number(requestUrl.searchParams.get('endTime')),
            rateType: 'Regular'
          }]);
          return;
        }
        case '/api/v5/public/instruments':
          json(response, okxEnvelope(assets.map((asset) => ({
            instId: `${asset}-USDT-SWAP`,
            instType: 'SWAP',
            baseCcy: '',
            quoteCcy: '',
            settleCcy: 'USDT',
            ctType: 'linear',
            state: 'live',
            listTime: String(AS_OF - 8 * DAY),
            instFamily: `${asset}-USDT`
          }))));
          return;
        case '/api/v5/public/funding-rate': {
          const instId = requestUrl.searchParams.get('instId');
          if (instId === null) break;
          const asset = instId.replace(/-USDT-SWAP$/, '');
          json(response, okxEnvelope([{
            instId,
            fundingRate: nextRate(asset),
            fundingTime: String(AS_OF + 8 * HOUR),
            nextFundingTime: String(AS_OF + 16 * HOUR)
          }]));
          return;
        }
        case '/api/v5/public/funding-rate-history': {
          const instId = requestUrl.searchParams.get('instId');
          if (instId === null) break;
          json(response, okxEnvelope([{
            instId,
            realizedRate: '0.000001',
            fundingTime: String(AS_OF)
          }]));
          return;
        }
        case '/info': {
          const info = body as Record<string, unknown>;
          if (info.type === 'metaAndAssetCtxs') {
            json(response, [
              { universe: assets.map((name) => ({ name, szDecimals: 1, maxLeverage: 10 })) },
              assets.map((asset) => ({ funding: nextRate(asset), openInterest: '1', markPx: '1' }))
            ]);
            return;
          }
          if (info.type === 'fundingHistory') {
            json(response, [
              {
                coin: info.coin,
                fundingRate: '0.000001',
                premium: '0',
                time: info.startTime
              },
              {
                coin: info.coin,
                fundingRate: '0.000001',
                premium: '0',
                time: info.endTime
              }
            ]);
            return;
          }
          break;
        }
        case '/v5/market/instruments-info':
          json(response, bybitEnvelope({
            list: assets.map((asset) => ({
              symbol: `${asset}USDT`,
              contractType: 'LinearPerpetual',
              status: 'Trading',
              baseCoin: asset,
              quoteCoin: 'USDT',
              settleCoin: 'USDT',
              launchTime: String(AS_OF - 8 * DAY),
              fundingInterval: 480
            })),
            nextPageCursor: ''
          }));
          return;
        case '/v5/market/tickers':
          json(response, bybitEnvelope({
            category: 'linear',
            list: assets.map((asset) => ({
              symbol: `${asset}USDT`,
              fundingRate: nextRate(asset),
              nextFundingTime: String(AS_OF + 8 * HOUR),
              fundingIntervalHour: '8'
            }))
          }));
          return;
        case '/v5/market/funding/history': {
          const symbol = requestUrl.searchParams.get('symbol');
          if (symbol === null) break;
          json(response, bybitEnvelope({
            category: 'linear',
            list: [{
              symbol,
              fundingRate: '0.000001',
              fundingRateTimestamp: requestUrl.searchParams.get('endTime')
            }]
          }));
          return;
        }
        case '/api/v2/mix/market/contracts':
          json(response, bitgetEnvelope(assets.map((asset) => ({
            symbol: `${asset}USDT`,
            baseCoin: asset,
            quoteCoin: 'USDT',
            symbolStatus: 'normal',
            symbolType: 'perpetual',
            launchTime: String(AS_OF - 8 * DAY)
          }))));
          return;
        case '/api/v3/market/current-fund-rate':
          json(response, bitgetEnvelope(assets.map((asset) => ({
            symbol: `${asset}USDT`,
            fundingRate: nextRate(asset),
            fundingRateInterval: '8',
            nextUpdate: String(AS_OF + 8 * HOUR),
            minFundingRate: '-0.003',
            maxFundingRate: '0.003',
            cashDividend: '0',
            cashDividendNextUpdate: '0'
          }))));
          return;
        case '/api/v2/mix/market/history-fund-rate': {
          const symbol = requestUrl.searchParams.get('symbol');
          if (symbol === null) break;
          json(response, bitgetEnvelope([{
            symbol,
            fundingRate: '0.000001',
            fundingTime: String(AS_OF)
          }]));
          return;
        }
        case '/webhook': {
          webhookPayloads.push(body as GoogleChatMessage);
          try {
            await readFile(stateFile, 'utf8');
            stateExistedWhenWebhookReceived = true;
          } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            stateExistedWhenWebhookReceived = false;
          }
          json(response, { ok: true });
          return;
        }
      }

      response.writeHead(404);
      response.end();
    })().catch((error: unknown) => {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(error instanceof Error ? error.message : 'local test server error');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  });

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'bn-funding-e2e-'));
  stateFile = path.join(temporaryDirectory, 'state.json');
  t.after(async () => { await rm(temporaryDirectory, { recursive: true, force: true }); });

  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const baseUrl = new URL(`http://127.0.0.1:${address.port}`);
  const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
  let publishedImages: readonly FundingReportImage[] = [];
  const deps = {
    venues: {
      binance: new BinanceVenueAdapter({ baseUrl }),
      okx: new OkxClient({ baseUrl, minRequestIntervalMs: 0, now: () => AS_OF }),
      hyperliquid: new HyperliquidClient({ baseUrl, now: () => AS_OF }),
      bybit: new BybitClient({ baseUrl, minRequestIntervalMs: 0, now: () => AS_OF }),
      bitget: new BitgetClient({ baseUrl, minRequestIntervalMs: 0, now: () => AS_OF })
    },
    renderImages: renderFundingReportImages,
    imagePublisher: {
      publish: async (images: readonly FundingReportImage[]) => {
        publishedImages = images;
        return {
          first: 'https://raw.githubusercontent.com/jordan/repo/images/top-1-10.png',
          second: 'https://raw.githubusercontent.com/jordan/repo/images/top-11-20.png'
        };
      }
    },
    chat: new GoogleChatClient({ webhookUrl: new URL('/webhook', baseUrl) }),
    state: new FileRunStateStore(stateFile),
    now: () => AS_OF + 1,
    logger
  };

  const result = await runFundingJob(deps, {
    slot,
    trigger: 'manual',
    dryRun: false,
    force: true
  });

  assert.deepEqual(result, { status: 'sent', slot: slot.key, rowCount: 20 });
  assert.equal(webhookPayloads.length, 1);
  assert.equal(webhookPayloads[0]!.cardsV2.length, 2);
  assert.deepEqual(publishedImages.map(({ range }) => range), ['1-10', '11-20']);
  assert.ok(publishedImages.every(({ png }) => png.subarray(1, 4).toString('ascii') === 'PNG'));
  assert.match(JSON.stringify(webhookPayloads[0]), /top-1-10\.png/);
  assert.match(JSON.stringify(webhookPayloads[0]), /top-11-20\.png/);
  assert.equal(stateExistedWhenWebhookReceived, false);
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).lastSuccessfulSlot, slot.key);

  assert.equal(routeCalls.filter(({ path: requestPath }) => requestPath === '/fapi/v1/fundingRate').length, 20);
  assert.equal(routeCalls.filter(({ path: requestPath }) => requestPath === '/api/v5/public/funding-rate').length, 20);
  assert.equal(routeCalls.filter(({ path: requestPath }) => requestPath === '/api/v5/public/funding-rate-history').length, 20);
  assert.equal(routeCalls.filter(({ path: requestPath, body }) => (
    requestPath === '/info' && (body as Record<string, unknown>).type === 'fundingHistory'
  )).length, 20);
  assert.equal(routeCalls.filter(({ path: requestPath }) => requestPath === '/v5/market/funding/history').length, 20);
  assert.equal(routeCalls.filter(({ path: requestPath, query }) => (
    requestPath === '/api/v2/mix/market/history-fund-rate' && query.pageNo === '1'
  )).length, 20);

  const venueAndWebhookCallsAfterSend = routeCalls.length;
  const duplicateResult = await runFundingJob(deps, {
    slot,
    trigger: 'manual',
    dryRun: false,
    force: false
  });

  assert.deepEqual(duplicateResult, { status: 'skipped', slot: slot.key, reason: 'already-sent' });
  assert.equal(routeCalls.length, venueAndWebhookCallsAfterSend);
  assert.equal(webhookPayloads.length, 1);
});
