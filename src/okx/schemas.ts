import { z } from 'zod';

const okxEnvelope = <T extends z.ZodTypeAny>(data: T) => z.object({
  code: z.string(),
  msg: z.string(),
  data: z.array(data)
});

export const okxInstrumentSchema = z.object({
  instId: z.string(),
  instType: z.string(),
  baseCcy: z.string(),
  quoteCcy: z.string(),
  settleCcy: z.string(),
  ctType: z.string(),
  state: z.string(),
  listTime: z.string(),
  instFamily: z.string(),
  instCategory: z.string().optional().default('')
});

export const okxCurrentFundingSchema = z.object({
  instId: z.string(),
  fundingRate: z.string(),
  fundingTime: z.string(),
  nextFundingTime: z.string()
});

export const okxHistorySchema = z.object({
  instId: z.string(),
  realizedRate: z.string(),
  fundingTime: z.string()
});

export const okxInstrumentsEnvelopeSchema = okxEnvelope(okxInstrumentSchema);
export const okxCurrentFundingEnvelopeSchema = okxEnvelope(okxCurrentFundingSchema);
export const okxHistoryEnvelopeSchema = okxEnvelope(okxHistorySchema);
