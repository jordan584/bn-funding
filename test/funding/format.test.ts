import assert from 'node:assert/strict';
import test from 'node:test';
import { Decimal } from 'decimal.js';

import type { FundingLeaderboard } from '../../src/domain.js';
import { formatAprPercent, formatFundingPercent, renderLeaderboardText } from '../../src/funding/format.js';
import { AS_OF } from '../helpers/fixtures.js';

test('rounds funding and APR percentages only for display with half-up negative handling', () => {
  assert.equal(formatFundingPercent(new Decimal('0.00012549')), '0.0125%');
  assert.equal(formatFundingPercent(new Decimal('-0.0001255')), '-0.0126%');
  assert.equal(formatAprPercent(new Decimal('0.136875')), '13.69%');
});

test('renders dry-run leaderboard rows and a partial-history footer without webhook data', () => {
  const leaderboard: FundingLeaderboard = {
    asOf: AS_OF,
    eligibleContractCount: 1,
    historyRecordCount: 2,
    rows: [{
      rank: 1, symbol: 'BTCUSDT', asset: 'BTC', exchange: 'Binance', intervalHours: 8,
      currentRate: new Decimal('0.000125'), currentApr: new Decimal('0.136875'),
      funding24h: new Decimal('0.000375'), apr24h: new Decimal('0.136875'),
      funding7d: new Decimal('0.0005'), apr7d: new Decimal('0.026071428571428571'),
      partialSevenDayHistory: true
    }]
  };

  const text = renderLeaderboardText(leaderboard);
  assert.match(text, /1\. BTC \(Binance\)/);
  assert.match(text, /Current: 0\.0125%\/8h \(13\.69%\)/);
  assert.match(text, /24h: 0\.0375% \(13\.69%\)/);
  assert.match(text, /7d: 0\.0500% \(2\.61%\)\*/);
  assert.match(text, /新上线资产的 7 日数据按可用历史累计/);
  assert.doesNotMatch(text, /webhook/i);
});
