import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BinanceVenueAdapter } from '../../src/binance/adapter.js';
import { GoogleChatClient } from '../../src/chat/client.js';
import {
  type FundingVenueAdapter,
  type GoogleChatMessage,
  type Logger,
  type ScheduledSlot,
  type VenueHistoryRequest,
  type VenueId
} from '../../src/domain.js';
import { runFundingJob } from '../../src/job.js';
import { FileRunStateStore } from '../../src/state/store.js';
import { AS_OF, DAY, contract, history, interval, premium } from '../helpers/fixtures.js';

const slot: ScheduledSlot = { key: '2026-08-03T16', scheduledAtMs: AS_OF };
const binancePaths = [
  '/fapi/v1/time',
  '/fapi/v1/exchangeInfo',
  '/fapi/v1/fundingRate',
  '/fapi/v1/premiumIndex',
  '/fapi/v1/fundingInfo'
] as const;

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function requestBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
  }
  return body;
}

function assetsFrom(message: GoogleChatMessage): string[] {
  return message.cardsV2.flatMap(({ card }) => {
    const sections = card.sections as Array<{ widgets: Array<{ textParagraph?: { text: string } }> }>;
    return sections.flatMap(({ widgets }) => widgets.flatMap((widget) => {
      const match = widget.textParagraph?.text.match(/^<b>#\d+ ([A-Z0-9]+)<\/b>/);
      return match === null || match === undefined ? [] : [match[1]!];
    }));
  });
}

test('sends the real local HTTP Top20 once, persists after webhook success, and skips the duplicate slot', async (t) => {
  const symbols = Array.from({ length: 20 }, (_, index) => `ASSET${String(index + 1).padStart(2, '0')}USDT`);
  const contracts = symbols.map((symbol) => contract(symbol));
  const historyRecords = symbols.flatMap((symbol, index) => {
    const rate = `0.000${String(20 - index).padStart(2, '0')}000`;
    return [
      history(symbol, rate, AS_OF - DAY + 1),
      history(symbol, rate, AS_OF - 1)
    ];
  });
  const premiums = symbols.map((symbol) => premium(symbol));
  const intervals = symbols.map((symbol) => interval(symbol, 8));
  const routeCalls: string[] = [];
  const webhookPayloads: GoogleChatMessage[] = [];
  let stateFile = '';
  let stateExistedWhenWebhookReceived: boolean | undefined;

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    routeCalls.push(requestUrl.pathname);
    switch (requestUrl.pathname) {
      case '/fapi/v1/time':
        json(response, { serverTime: AS_OF });
        return;
      case '/fapi/v1/exchangeInfo':
        json(response, { symbols: contracts });
        return;
      case '/fapi/v1/fundingRate':
        json(response, historyRecords.filter((record) => (
          requestUrl.searchParams.get('symbol') === null
          || record.symbol === requestUrl.searchParams.get('symbol')
        )));
        return;
      case '/fapi/v1/premiumIndex':
        json(response, premiums);
        return;
      case '/fapi/v1/fundingInfo':
        json(response, intervals);
        return;
      case '/webhook': {
        webhookPayloads.push(JSON.parse(await requestBody(request)) as GoogleChatMessage);
        try {
          await readFile(stateFile, 'utf8');
          stateExistedWhenWebhookReceived = true;
        } catch (error: unknown) {
          assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
          stateExistedWhenWebhookReceived = false;
        }
        json(response, { ok: true });
        return;
      }
      default:
        response.writeHead(404);
        response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  });

  const directory = await mkdtemp(path.join(tmpdir(), 'bn-funding-e2e-'));
  stateFile = path.join(directory, 'state.json');
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const baseUrl = new URL(`http://127.0.0.1:${address.port}`);
  const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
  const stubVenue = (venue: Exclude<VenueId, 'binance'>): FundingVenueAdapter => ({
    id: venue,
    getCurrentSnapshot: async () => ({
      venue,
      observedAt: AS_OF,
      markets: symbols.map((symbol) => ({
        venue,
        marketId: `${venue}-${symbol}`,
        rawBaseAsset: symbol.replace(/USDT$/, ''),
        quoteAsset: venue === 'hyperliquid' ? 'USD' : 'USDT',
        settleAsset: venue === 'hyperliquid' ? 'USDC' : 'USDT',
        nextFundingRate: '0.0001',
        intervalHours: 8,
        nextFundingTime: AS_OF + 8 * 60 * 60 * 1_000
      })),
      stats: { marketCount: symbols.length, requestCount: 1, pageCount: 1 }
    }),
    getFundingHistory: async (request: VenueHistoryRequest) => ({
      records: [{
        venue,
        marketId: request.market.marketId,
        fundingRate: '0.0001',
        fundingTime: request.endTime - 1
      }],
      requestCount: 1,
      pageCount: 1,
      completeFrom: request.startTime
    })
  });
  const deps = {
    venues: {
      binance: new BinanceVenueAdapter({ baseUrl }),
      okx: stubVenue('okx'),
      hyperliquid: stubVenue('hyperliquid'),
      bybit: stubVenue('bybit'),
      bitget: stubVenue('bitget')
    },
    chat: new GoogleChatClient({ webhookUrl: new URL('/webhook', baseUrl) }),
    state: new FileRunStateStore(stateFile),
    now: () => AS_OF + 1,
    logger
  };

  const sent = await runFundingJob(deps, {
    slot,
    trigger: 'manual',
    dryRun: false,
    force: true
  });

  assert.deepEqual(sent, { status: 'sent', slot: slot.key, rowCount: 20 });
  assert.deepEqual(Object.fromEntries(binancePaths.map((route) => [
    route,
    routeCalls.filter((call) => call === route).length
  ])), {
    '/fapi/v1/time': 1,
    '/fapi/v1/exchangeInfo': 1,
    '/fapi/v1/fundingRate': 20,
    '/fapi/v1/premiumIndex': 1,
    '/fapi/v1/fundingInfo': 1
  });
  assert.equal(routeCalls.filter((call) => call === '/webhook').length, 1);
  assert.equal(webhookPayloads.length, 1);
  const webhookPayload = webhookPayloads[0]!;
  assert.equal(webhookPayload.cardsV2.length, 2);
  assert.deepEqual(assetsFrom(webhookPayload), symbols.map((symbol) => symbol.replace(/USDT$/, '')));
  assert.equal(stateExistedWhenWebhookReceived, false);
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), {
    lastSuccessfulSlot: slot.key,
    scheduledAt: new Date(slot.scheduledAtMs).toISOString(),
    updatedAt: new Date(AS_OF + 1).toISOString()
  });

  const httpCallsAfterSend = routeCalls.length;
  const skipped = await runFundingJob(deps, {
    slot,
    trigger: 'manual',
    dryRun: false,
    force: false
  });

  assert.deepEqual(skipped, { status: 'skipped', slot: slot.key, reason: 'already-sent' });
  assert.equal(routeCalls.length, httpCallsAfterSend);
});
