import { Webhook, MessageBuilder } from '@/misc/webhook/index.js';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  buildCompleteRatingById,
  getRatingListPage,
  type RatingListOrder,
  type RatingListSort,
} from '@/server/services/ratings/ratingListService.js';
import {
  isZenDeckSize,
  peeksAllowedForDeckSize,
  ZEN_DECK_UNIT,
  ZEN_DEFAULT_DECK_SIZE,
  type ZenDeckSize,
} from '@/server/services/ratings/zenRatingConstants.js';

export interface ZenDealOptions {
  deckSize?: number;
  onlyLowDiff?: boolean;
  sort?: RatingListSort;
  order?: RatingListOrder;
}

export interface ZenDealResult {
  deckUnit: number;
  deckSize: number;
  peeksAllowed: number;
  sort: RatingListSort;
  order: RatingListOrder;
  onlyLowDiff: boolean;
  dealtAt: string;
  cards: Record<string, unknown>[];
}

export function parseZenDealOptions(body: Record<string, unknown>): {
  deckSize: ZenDeckSize;
  onlyLowDiff: boolean;
  sort: RatingListSort;
  order: RatingListOrder;
} {
  const rawSize = body.deckSize ?? ZEN_DEFAULT_DECK_SIZE;
  if (!isZenDeckSize(rawSize)) {
    throw Object.assign(new Error('Invalid deckSize'), { status: 400 });
  }
  const deckSize = Number(rawSize) as ZenDeckSize;

  const sortRaw = String(body.sort || 'ratings');
  const sort: RatingListSort =
    sortRaw === 'id' || sortRaw === 'updatedAt' || sortRaw === 'ratings'
      ? sortRaw
      : 'ratings';

  const order: RatingListOrder =
    String(body.order || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  const onlyLowDiff =
    body.onlyLowDiff === true ||
    body.onlyLowDiff === 'true' ||
    body.onlyLowDiff === '1';

  return { deckSize, onlyLowDiff, sort, order };
}

/**
 * Deal a finite Zen deck: unrated-by-user, &lt;4 manager votes, exclude VOTE, optional lowDiff.
 * Uncached; returns complete rating snapshots for offline session play.
 * Options come from GET query params (same shape as {@link parseZenDealOptions}).
 */
export async function dealZenDeck(
  userId: string,
  options: ZenDealOptions | Record<string, unknown> = {}
): Promise<ZenDealResult> {
  const parsed = parseZenDealOptions(options as Record<string, unknown>);

  const page = await getRatingListPage({
    offset: 0,
    limit: parsed.deckSize,
    query: '',
    sort: parsed.sort,
    order: parsed.order,
    lowDiff: parsed.onlyLowDiff ? 'only' : 'show',
    fourVote: 'hide',
    hideRated: true,
    vote: 'exclude',
    userId,
    levelIdsFilter: null,
  });

  const cards: Record<string, unknown>[] = [];
  for (const row of page.results) {
    const id = Number((row as { id?: unknown }).id);
    if (!Number.isFinite(id) || id <= 0) continue;
    const complete = await buildCompleteRatingById(id);
    if (complete) {
      cards.push(complete);
    }
  }

  return {
    deckUnit: ZEN_DECK_UNIT,
    deckSize: parsed.deckSize,
    peeksAllowed: peeksAllowedForDeckSize(parsed.deckSize),
    sort: parsed.sort,
    order: parsed.order,
    onlyLowDiff: parsed.onlyLowDiff,
    dealtAt: new Date().toISOString(),
    cards,
  };
}

const MAX_REPORT_NOTE_LENGTH = 500;

export async function sendZenMediaReport(opts: {
  reporterId: string;
  reporterName: string;
  ratingId: number;
  levelId: number;
  note?: string;
}): Promise<void> {
  const webhookUrl = (process.env.RATING_ZEN_REPORT_WEBHOOK_URL || '').trim();
  if (!webhookUrl) {
    logger.warn('RATING_ZEN_REPORT_WEBHOOK_URL is not set; cannot deliver Zen report');
    const err = new Error('Report webhook is not configured');
    (err as Error & { status?: number }).status = 503;
    throw err;
  }

  const note =
    typeof opts.note === 'string'
      ? opts.note.trim().slice(0, MAX_REPORT_NOTE_LENGTH)
      : '';

  const siteUrl = (process.env.FRONTEND_URL || process.env.CLIENT_URL || '').replace(
    /\/$/,
    ''
  );
  const levelLink = siteUrl
    ? `${siteUrl}/levels/${opts.levelId}`
    : `/levels/${opts.levelId}`;
  const ratingLink = siteUrl
    ? `${siteUrl}/rating#${opts.levelId}`
    : `/rating#${opts.levelId}`;

  const embed = new MessageBuilder()
    .setTitle('Zen Mode media report')
    .setColor(0xdc3545)
    .setTimestamp()
    .addField('Reporter', `${opts.reporterName} (\`${opts.reporterId}\`)`, false)
    .addField('Rating ID', String(opts.ratingId), true)
    .addField('Level ID', String(opts.levelId), true)
    .addField('Level', levelLink, false)
    .addField('Queue link', ratingLink, false);

  if (note) {
    embed.addField('Note', note, false);
  }

  const hook = new Webhook({ url: webhookUrl, throwErrors: true });
  await hook.send(embed);
}
