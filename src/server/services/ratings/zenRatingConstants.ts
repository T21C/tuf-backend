export const ZEN_DECK_UNIT = 5;
export const ZEN_DEFAULT_DECK_SIZE = 15;
export const ZEN_MAX_DECK_SIZE = 30;
export const ZEN_ALLOWED_DECK_SIZES = [5, 10, 15, 20, 25, 30] as const;

export type ZenDeckSize = (typeof ZEN_ALLOWED_DECK_SIZES)[number];

export function isZenDeckSize(value: unknown): value is ZenDeckSize {
  const n = Number(value);
  return (ZEN_ALLOWED_DECK_SIZES as readonly number[]).includes(n);
}

export function peeksAllowedForDeckSize(deckSize: number): number {
  return Math.floor(deckSize / ZEN_DECK_UNIT);
}
