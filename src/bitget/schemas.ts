import { z } from 'zod';

const bitgetEnvelope = <T extends z.ZodType>(data: T) => z.object({
  code: z.string(),
  msg: z.string(),
  requestTime: z.union([z.string(), z.number().finite()]),
  data: z.array(data)
});

export const bitgetContractSchema = z.object({
  symbol: z.string(),
  baseCoin: z.string(),
  quoteCoin: z.string(),
  symbolStatus: z.string(),
  symbolType: z.string(),
  launchTime: z.string(),
  isRwa: z.string().optional().default('NO')
});

export const bitgetCurrentFundingSchema = z.object({
  symbol: z.string(),
  fundingRate: z.string(),
  fundingRateInterval: z.enum(['1', '2', '4', '8']),
  nextUpdate: z.string(),
  minFundingRate: z.string().nullable(),
  maxFundingRate: z.string().nullable(),
  cashDividend: z.string().nullable(),
  cashDividendNextUpdate: z.string().nullable()
});

export const bitgetFundingHistorySchema = z.object({
  symbol: z.string(),
  fundingRate: z.string(),
  fundingTime: z.string()
});

export const bitgetContractsEnvelopeSchema = bitgetEnvelope(bitgetContractSchema);
export const bitgetCurrentFundingEnvelopeSchema = bitgetEnvelope(bitgetCurrentFundingSchema);
export const bitgetFundingHistoryEnvelopeSchema = bitgetEnvelope(bitgetFundingHistorySchema);
