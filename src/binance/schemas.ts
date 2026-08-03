import { z } from 'zod';

const finiteNumber = z.number().finite();

export const serverTimeResponseSchema = z.object({
  serverTime: finiteNumber
});

export const exchangeSymbolSchema = z.object({
  symbol: z.string(),
  baseAsset: z.string(),
  quoteAsset: z.string(),
  contractType: z.string(),
  status: z.string(),
  onboardDate: finiteNumber
});

export const exchangeInfoResponseSchema = z.object({
  symbols: z.array(exchangeSymbolSchema)
});

export const fundingHistoryRecordSchema = z.object({
  symbol: z.string(),
  fundingRate: z.string(),
  fundingTime: finiteNumber,
  rateType: z.enum(['Regular', 'Special']).optional().default('Regular')
});

export const fundingHistoryResponseSchema = z.array(fundingHistoryRecordSchema);

export const premiumIndexRecordSchema = z.object({
  symbol: z.string(),
  lastFundingRate: z.string(),
  nextFundingTime: finiteNumber
});

export const premiumIndexResponseSchema = z.array(premiumIndexRecordSchema);

export const fundingIntervalInfoSchema = z.object({
  symbol: z.string(),
  fundingIntervalHours: finiteNumber
});

export const fundingInfoResponseSchema = z.array(fundingIntervalInfoSchema);
