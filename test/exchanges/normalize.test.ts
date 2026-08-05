import assert from 'node:assert/strict';
import test from 'node:test';

import { VENUE_IDS } from '../../src/domain.js';
import { normalizeAsset, normalizeAssetWithDiagnostics } from '../../src/exchanges/normalize.js';

test('uses the five approved venues in stable card order', () => {
  assert.deepEqual(VENUE_IDS, ['binance', 'okx', 'hyperliquid', 'bybit', 'bitget']);
});

test('normalizes case and approved multiplier aliases without guessing', () => {
  assert.equal(normalizeAsset('binance', 'btc'), 'BTC');
  assert.equal(normalizeAsset('binance', ' 币安人生 '), '币安人生');
  assert.equal(normalizeAsset('binance', '1000PEPE'), 'PEPE');
  assert.equal(normalizeAsset('hyperliquid', 'kPEPE'), 'PEPE');
  assert.equal(normalizeAsset('bybit', '1MBABYDOGE'), 'BABYDOGE');
  assert.equal(normalizeAsset('okx', '1000UNKNOWN'), '1000UNKNOWN');
});

test('rejects blank or unsafe asset identifiers', () => {
  assert.throws(() => normalizeAsset('bitget', ''), /Invalid bitget base asset/);
  assert.throws(() => normalizeAsset('okx', 'BTC<'), /Invalid okx base asset/);
  assert.throws(() => normalizeAsset('binance', '币 安'), /Invalid binance base asset/);
  assert.throws(() => normalizeAsset('binance', '币-安'), /Invalid binance base asset/);
  assert.throws(() => normalizeAsset('binance', '币\u0000安'), /Invalid binance base asset/);
});

test('reports explicit alias hits without treating ordinary case normalization as an alias', () => {
  assert.deepEqual(
    normalizeAssetWithDiagnostics('binance', '1000PEPE'),
    { asset: 'PEPE', explicitAlias: true }
  );
  assert.deepEqual(
    normalizeAssetWithDiagnostics('binance', 'btc'),
    { asset: 'BTC', explicitAlias: false }
  );
});
