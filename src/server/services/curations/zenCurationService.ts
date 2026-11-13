import {
  buildCompleteCurationRatingById,
  getCurationRatingListPage,
  type CurationRatingListOrder,
  type CurationRatingListSort,
} from '@/server/services/curations/curationRatingListService.js';
import {sendZenMediaReport} from '@/server/services/ratings/zenRatingService.js';
import {
  clampZenRandomness,
  parseZenDeckSize,
  peeksAllowedForDeckSize,
  sampleZenPoolIndices,
  ZEN_CANDIDATE_POOL_CAP,
  ZEN_DECK_UNIT,
  ZEN_DEFAULT_DECK_SIZE,
  ZEN_DEFAULT_RANDOMNESS,
} from '@/server/services/ratings/zenRatingConstants.js';

export async function dealZenCurationDeck(
  userId: string,
  options: Record<string, unknown> = {},
) {
  const deckSize = parseZenDeckSize(options.deckSize ?? ZEN_DEFAULT_DECK_SIZE);
  const sortRaw = String(options.sort || 'ratings');
  const sort: CurationRatingListSort =
    sortRaw === 'id' || sortRaw === 'updatedAt' || sortRaw === 'ratings'
      ? sortRaw
      : 'ratings';
  const order: CurationRatingListOrder =
    String(options.order || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  const randomness = clampZenRandomness(
    options.randomness === undefined || options.randomness === null || options.randomness === ''
      ? ZEN_DEFAULT_RANDOMNESS
      : options.randomness,
  );

  const poolLimit = Math.max(deckSize, ZEN_CANDIDATE_POOL_CAP);
  const page = await getCurationRatingListPage({
    offset: 0,
    limit: poolLimit,
    query: '',
    sort,
    order,
    myRated: 'hide',
    flow: null,
    vote: 'exclude',
    userId,
  });

  const candidateIds: number[] = [];
  for (const row of page.results) {
    const id = Number((row as {id?: unknown}).id);
    if (!Number.isFinite(id) || id <= 0) continue;
    candidateIds.push(id);
  }

  const selectedIndices = sampleZenPoolIndices(
    candidateIds.length,
    deckSize,
    randomness,
  );

  const cards: Record<string, unknown>[] = [];
  for (const idx of selectedIndices) {
    const id = candidateIds[idx];
    if (id == null) continue;
    const complete = await buildCompleteCurationRatingById(id);
    if (complete) cards.push(complete);
  }

  return {
    deckUnit: ZEN_DECK_UNIT,
    deckSize,
    peeksAllowed: peeksAllowedForDeckSize(cards.length),
    sort,
    order,
    randomness,
    dealtAt: new Date().toISOString(),
    cards,
  };
}

export async function sendCurationZenMediaReport(opts: {
  reporterId: string;
  reporterName: string;
  reporterAvatarUrl?: string | null;
  reporterPlayerId?: number | null;
  ratingId: number;
  levelId: number;
  note?: string;
}): Promise<void> {
  await sendZenMediaReport(opts);
}
