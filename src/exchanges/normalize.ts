import type { VenueId } from '../domain.js';

const ALIASES: Record<VenueId, Readonly<Record<string, string>>> = {
  binance: {
    '1000BONK': 'BONK',
    '1000FLOKI': 'FLOKI',
    '1000LUNC': 'LUNC',
    '1000PEPE': 'PEPE',
    '1000SATS': 'SATS',
    '1000SHIB': 'SHIB',
    '1000XEC': 'XEC',
    '1MBABYDOGE': 'BABYDOGE'
  },
  okx: {},
  hyperliquid: { kBONK: 'BONK', kFLOKI: 'FLOKI', kLUNC: 'LUNC', kPEPE: 'PEPE', kSHIB: 'SHIB' },
  bybit: { '1000BONK': 'BONK', '1000FLOKI': 'FLOKI', '1000PEPE': 'PEPE', '1000SHIB': 'SHIB', '1MBABYDOGE': 'BABYDOGE' },
  bitget: { '1000BONK': 'BONK', '1000FLOKI': 'FLOKI', '1000PEPE': 'PEPE', '1000SHIB': 'SHIB' }
};

export function normalizeAsset(venue: VenueId, rawBaseAsset: string): string {
  const normalized = rawBaseAsset.trim().toUpperCase();
  if (!/^[A-Z0-9]+$/.test(normalized)) {
    throw new Error(`Invalid ${venue} base asset`);
  }
  const venueAliases = Object.fromEntries(
    Object.entries(ALIASES[venue]).map(([key, value]) => [key.toUpperCase(), value])
  );
  return venueAliases[normalized] ?? normalized;
}
