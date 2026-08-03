import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFundingLeaderboard } from '../../src/funding/aggregate.js';
import { AS_OF, DAY, HOUR, contract, history, interval, premium } from '../helpers/fixtures.js';

const symbols = Array.from({ length: 20 }, (_, index) => `FILL${String(index).padStart(2, '0')}USDT`);

test('uses eligible contracts, Regular records, and (start, end] windows with Decimal APRs', () => {
  const contracts = [
    contract('ONEUSDT', 'ONE'),
    contract('FOURUSDT', 'FOUR'),
    { ...contract('EIGHTUSDT', 'EIGHT'), onboardDate: AS_OF - 7 * DAY + 1 },
    ...symbols.map((symbol) => contract(symbol)),
    { ...contract('PAUSEDUSDT'), status: 'BREAK' },
    { ...contract('DELIVERYUSDT'), contractType: 'CURRENT_QUARTER' },
    { ...contract('USDCUSDC'), quoteAsset: 'USDC' }
  ];
  const records = [
    history('ONEUSDT', '0.500000', AS_OF - 7 * DAY),
    history('ONEUSDT', '0.000002', AS_OF - 7 * DAY + 1),
    history('ONEUSDT', '0.000003', AS_OF - DAY),
    history('ONEUSDT', '0.000004', AS_OF - DAY + 1),
    history('ONEUSDT', '0.000005', AS_OF),
    history('ONEUSDT', '0.700000', AS_OF + 1),
    history('ONEUSDT', '0.900000', AS_OF - HOUR, 'Special'),
    history('FOURUSDT', '0.000000', AS_OF - HOUR),
    history('EIGHTUSDT', '0.000000', AS_OF - HOUR),
    history('PAUSEDUSDT', '0.900000', AS_OF - HOUR),
    ...symbols.map((symbol) => history(symbol, '0.000000', AS_OF - HOUR))
  ];

  const leaderboard = buildFundingLeaderboard({
    asOf: AS_OF,
    contracts,
    history: records,
    premiumIndexes: [
      premium('ONEUSDT'), premium('FOURUSDT'), premium('EIGHTUSDT'),
      ...symbols.map((symbol) => premium(symbol, '0')), premium('PAUSEDUSDT', 'not-a-number')
    ],
    intervals: [interval('ONEUSDT', 1), interval('FOURUSDT', 4)]
  });

  assert.equal(leaderboard.eligibleContractCount, 23);
  assert.equal(leaderboard.rows.length, 20);
  const one = leaderboard.rows.find((row) => row.symbol === 'ONEUSDT');
  const four = leaderboard.rows.find((row) => row.symbol === 'FOURUSDT');
  const eight = leaderboard.rows.find((row) => row.symbol === 'EIGHTUSDT');
  assert.ok(one && four && eight);
  assert.equal(one.intervalHours, 1);
  assert.equal(one.currentApr.toString(), '0.876');
  assert.equal(one.funding24h.toString(), '0.000009');
  assert.equal(one.apr24h.toString(), '0.003285');
  assert.equal(one.funding7d.toString(), '0.000014');
  assert.equal(one.apr7d.toString(), '0.00073');
  assert.equal(four.intervalHours, 4);
  assert.equal(four.currentApr.toString(), '0.219');
  assert.equal(eight.intervalHours, 8);
  assert.equal(eight.currentApr.toString(), '0.1095');
  assert.equal(eight.partialSevenDayHistory, true);
  assert.equal(leaderboard.rows.some((row) => row.symbol === 'PAUSEDUSDT'), false);
});

test('ranks 22 assets by 24h funding, current rate, then symbol and retains negative values', () => {
  const ranked = [
    ['AUSDT', '0.010000', '0.000200'],
    ['BUSDT', '0.010000', '0.000300'],
    ['CUSDT', '0.010000', '0.000200'],
    ...Array.from({ length: 15 }, (_, index) => [
      `P${String(index).padStart(2, '0')}USDT`,
      `0.00${String(900 - index).padStart(4, '0')}`,
      '0.000100'
    ]),
    ['NEGAUSDT', '-0.001000', '-0.000100'],
    ['NEGBUSDT', '-0.002000', '-0.000100'],
    ['OMITAUSDT', '-0.003000', '-0.000100'],
    ['OMITBUSDT', '-0.004000', '-0.000100']
  ] as const;
  const leaderboard = buildFundingLeaderboard({
    asOf: AS_OF,
    contracts: ranked.map(([symbol]) => contract(symbol)),
    history: ranked.map(([symbol, rate]) => history(symbol, rate, AS_OF - HOUR)),
    premiumIndexes: ranked.map(([symbol, _rate, currentRate]) => premium(symbol, currentRate)),
    intervals: []
  });

  assert.equal(leaderboard.rows.length, 20);
  assert.deepEqual(leaderboard.rows.slice(0, 3).map((row) => row.symbol), ['BUSDT', 'AUSDT', 'CUSDT']);
  assert.deepEqual(leaderboard.rows.slice(-2).map((row) => row.symbol), ['NEGAUSDT', 'NEGBUSDT']);
  assert.deepEqual(leaderboard.rows.map((row) => row.rank), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal(leaderboard.rows.every((row, index, rows) => index === 0 || rows[index - 1]!.funding24h.gte(row.funding24h)), true);
});

test('fails closed when the highest-24h eligible contract with settled history lacks current premium', () => {
  const rankedSymbols = ['MISSINGUSDT', ...symbols];

  assert.throws(() => buildFundingLeaderboard({
    asOf: AS_OF,
    contracts: rankedSymbols.map((symbol) => contract(symbol)),
    history: rankedSymbols.map((symbol, index) =>
      history(symbol, index === 0 ? '0.100000' : '0.000100', AS_OF - HOUR)
    ),
    premiumIndexes: symbols.map((symbol) => premium(symbol)),
    intervals: []
  }), /Missing current premium index for MISSINGUSDT/);
});

test('rejects incomplete, non-finite, and non-positive-rate leaderboard inputs', () => {
  const nineteen = Array.from({ length: 19 }, (_, index) => `N${String(index).padStart(2, '0')}USDT`);
  assert.throws(() => buildFundingLeaderboard({
    asOf: AS_OF,
    contracts: nineteen.map((symbol) => contract(symbol)),
    history: [],
    premiumIndexes: nineteen.map((symbol) => premium(symbol)),
    intervals: []
  }), /Funding leaderboard has fewer than 20 valid assets/);

  assert.throws(() => buildFundingLeaderboard({
    asOf: AS_OF,
    contracts: symbols.map((symbol) => contract(symbol)),
    history: symbols.slice(0, 19).map((symbol) => history(symbol, '0.000000', AS_OF - HOUR)),
    premiumIndexes: symbols.map((symbol) => premium(symbol)),
    intervals: []
  }), /Funding leaderboard has fewer than 20 valid assets/);

  assert.throws(() => buildFundingLeaderboard({
    asOf: AS_OF,
    contracts: symbols.map((symbol) => contract(symbol)),
    history: [],
    premiumIndexes: [premium(symbols[0]!, 'not-a-number'), ...symbols.slice(1).map((symbol) => premium(symbol))],
    intervals: []
  }), /Invalid funding rate/);

  assert.throws(() => buildFundingLeaderboard({
    asOf: AS_OF,
    contracts: symbols.map((symbol) => contract(symbol)),
    history: [],
    premiumIndexes: symbols.map((symbol) => premium(symbol)),
    intervals: [interval(symbols[0]!, 0)]
  }), /Invalid funding interval/);
});
