import { z } from 'zod';

const bybitEnvelope = <T extends z.ZodTypeAny>(result: T) => z.object({
  retCode: z.number().int(),
  retMsg: z.string(),
  result,
  time: z.number().finite()
});

export const bybitInstrumentSchema = z.object({
  symbol: z.string(),
  contractType: z.string(),
  status: z.string(),
  baseCoin: z.string(),
  quoteCoin: z.string(),
  settleCoin: z.string(),
  launchTime: z.string(),
  fundingInterval: z.number().finite()
});

export const bybitTickerSchema = z.object({
  symbol: z.string(),
  fundingRate: z.string(),
  nextFundingTime: z.string(),
  fundingIntervalHour: z.string().optional()
});

export const bybitFundingHistorySchema = z.object({
  symbol: z.string(),
  fundingRate: z.string(),
  fundingRateTimestamp: z.string()
});

export const bybitInstrumentsEnvelopeSchema = bybitEnvelope(z.object({
  list: z.array(bybitInstrumentSchema),
  nextPageCursor: z.string()
}));

export const bybitTickersEnvelopeSchema = bybitEnvelope(z.object({
  category: z.string(),
  list: z.array(bybitTickerSchema)
}));

export const bybitFundingHistoryEnvelopeSchema = bybitEnvelope(z.object({
  category: z.string(),
  list: z.array(bybitFundingHistorySchema)
}));
