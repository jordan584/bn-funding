import { Decimal } from 'decimal.js';

import type {
  ExchangeSymbol,
  FundingHistoryRecord,
  FundingIntervalInfo,
  FundingLeaderboard,
  FundingRow,
  PremiumIndexRecord
} from '../domain.js';

const DEFAULT_INTERVAL_HOURS = 8;
const DAY_MS = 24 * 60 * 60 * 1_000;
const SEVEN_DAY_MS = 7 * DAY_MS;
const DAYS_PER_YEAR = new Decimal(365);

export interface BuildFundingLeaderboardInput {
  asOf: number;
  contracts: ExchangeSymbol[];
  history: FundingHistoryRecord[];
  premiumIndexes: PremiumIndexRecord[];
  intervals: FundingIntervalInfo[];
}

function decimalRate(value: string, symbol: string): Decimal {
  try {
    const rate = new Decimal(value);
    if (!rate.isFinite()) {
      throw new Error('not finite');
    }
    return rate;
  } catch {
    throw new Error(`Invalid funding rate for ${symbol}`);
  }
}

function isEligibleContract(contract: ExchangeSymbol): boolean {
  return contract.status === 'TRADING'
    && contract.contractType === 'PERPETUAL'
    && contract.quoteAsset === 'USDT';
}

export function buildFundingLeaderboard(input: BuildFundingLeaderboardInput): FundingLeaderboard {
  const eligibleContracts = input.contracts.filter(isEligibleContract);
  const eligibleBySymbol = new Map(eligibleContracts.map((contract) => [contract.symbol, contract]));
  const premiumBySymbol = new Map(input.premiumIndexes.map((premium) => [premium.symbol, premium]));
  const intervalBySymbol = new Map(input.intervals.map((interval) => [interval.symbol, interval.fundingIntervalHours]));
  const currentRateBySymbol = new Map<string, Decimal>();
  for (const [symbol, premium] of premiumBySymbol) {
    if (eligibleBySymbol.has(symbol)) {
      currentRateBySymbol.set(symbol, decimalRate(premium.lastFundingRate, symbol));
    }
  }
  for (const [symbol, intervalHours] of intervalBySymbol) {
    if (eligibleBySymbol.has(symbol) && (!Number.isFinite(intervalHours) || intervalHours <= 0)) {
      throw new Error(`Invalid funding interval for ${symbol}`);
    }
  }
  const start24h = input.asOf - DAY_MS;
  const start7d = input.asOf - SEVEN_DAY_MS;
  const sumsBySymbol = new Map<string, { funding24h: Decimal; funding7d: Decimal }>();

  for (const record of input.history) {
    if (record.rateType !== 'Regular' || !eligibleBySymbol.has(record.symbol)) {
      continue;
    }
    if (record.fundingTime <= start7d || record.fundingTime > input.asOf) {
      continue;
    }

    const rate = decimalRate(record.fundingRate, record.symbol);
    const sums = sumsBySymbol.get(record.symbol) ?? {
      funding24h: new Decimal(0),
      funding7d: new Decimal(0)
    };
    sums.funding7d = sums.funding7d.plus(rate);
    if (record.fundingTime > start24h) {
      sums.funding24h = sums.funding24h.plus(rate);
    }
    sumsBySymbol.set(record.symbol, sums);
  }

  const rows: FundingRow[] = [];
  for (const contract of eligibleContracts) {
    const currentRate = currentRateBySymbol.get(contract.symbol);
    if (currentRate === undefined) {
      continue;
    }
    const sums = sumsBySymbol.get(contract.symbol);
    if (sums === undefined) {
      continue;
    }
    const intervalHours = intervalBySymbol.get(contract.symbol) ?? DEFAULT_INTERVAL_HOURS;
    rows.push({
      rank: 0,
      symbol: contract.symbol,
      asset: contract.baseAsset,
      exchange: 'Binance',
      intervalHours,
      currentRate,
      currentApr: currentRate.times(24).div(intervalHours).times(DAYS_PER_YEAR),
      funding24h: sums.funding24h,
      apr24h: sums.funding24h.times(DAYS_PER_YEAR),
      funding7d: sums.funding7d,
      apr7d: sums.funding7d.times(DAYS_PER_YEAR).div(7),
      partialSevenDayHistory: contract.onboardDate > start7d
    });
  }

  if (rows.length < 20) {
    throw new Error('Funding leaderboard has fewer than 20 valid assets');
  }

  rows.sort((left, right) => {
    const fundingComparison = right.funding24h.comparedTo(left.funding24h);
    if (fundingComparison !== 0) {
      return fundingComparison;
    }
    const currentComparison = right.currentRate.comparedTo(left.currentRate);
    if (currentComparison !== 0) {
      return currentComparison;
    }
    return left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0;
  });

  const rankedRows = rows.slice(0, 20).map((row, index) => ({ ...row, rank: index + 1 }));
  for (let index = 1; index < rankedRows.length; index += 1) {
    if (!rankedRows[index - 1]!.funding24h.gte(rankedRows[index]!.funding24h)) {
      throw new Error('Funding leaderboard order validation failed');
    }
  }

  return {
    asOf: input.asOf,
    eligibleContractCount: eligibleContracts.length,
    historyRecordCount: input.history.length,
    rows: rankedRows
  };
}
