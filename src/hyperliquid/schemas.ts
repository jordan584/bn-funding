import { z } from 'zod';

export const hyperMetaSchema = z.object({
  universe: z.array(z.object({
    name: z.string(),
    szDecimals: z.number().int().nonnegative(),
    maxLeverage: z.number().positive(),
    isDelisted: z.boolean().optional().default(false)
  }))
});

export const hyperContextSchema = z.object({
  funding: z.string(),
  openInterest: z.string(),
  markPx: z.string().nullable().optional()
});

export const hyperMetaAndContextsSchema = z.tuple([
  hyperMetaSchema,
  z.array(hyperContextSchema)
]);

export const hyperFundingHistorySchema = z.array(z.object({
  coin: z.string(), fundingRate: z.string(), premium: z.string(), time: z.number().finite()
}));
