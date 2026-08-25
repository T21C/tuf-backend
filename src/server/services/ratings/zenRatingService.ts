import { Webhook, MessageBuilder } from '@/misc/webhook/index.js';
import { clientUrlEnv } from '@/config/app.config.js';
import { logger } from '@/server/services/core/LoggerService.js';
import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';
import Song from '@/models/songs/Song.js';
import {
  getArtistDisplayName,
  getSongDisplayName,
  getSongName,
} from '@/misc/utils/data/levelHelpers.js';
import { getPrimaryVideoLink } from '@/misc/utils/data/videoLinkParts.js';
import {
  buildCompleteRatingById,
  getRatingListPage,
  type RatingListOrder,
  type RatingListSort,
} from '@/server/services/ratings/ratingListService.js';
import {
  clampZenRandomness,
  isZenDeckSize,
  peeksAllowedForDeckSize,
  sampleZenPoolIndices,
  ZEN_CANDIDATE_POOL_CAP,
  ZEN_DECK_UNIT,
  ZEN_DEFAULT_DECK_SIZE,
  ZEN_DEFAULT_RANDOMNESS,
  type ZenDeckSize,
} from '@/server/services/ratings/zenRatingConstants.js';

export interface ZenDealOptions {
  deckSize?: number;
  onlyLowDiff?: boolean;
  excludeUniversals?: boolean;
  sort?: RatingListSort;
  order?: RatingListOrder;
  randomness?: number;
}

export interface ZenDealResult {
  deckUnit: number;
  deckSize: number;
  peeksAllowed: number;
  sort: RatingListSort;
  order: RatingListOrder;
  onlyLowDiff: boolean;
  excludeUniversals: boolean;
  randomness: number;
  dealtAt: string;
  cards: Record<string, unknown>[];
}

export function parseZenDealOptions(body: Record<string, unknown>): {
  deckSize: ZenDeckSize;
  onlyLowDiff: boolean;
  excludeUniversals: boolean;
  sort: RatingListSort;
  order: RatingListOrder;
  randomness: number;
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

  const excludeUniversals =
    body.excludeUniversals === true ||
    body.excludeUniversals === 'true' ||
    body.excludeUniversals === '1';

  const randomness = clampZenRandomness(
    body.randomness === undefined || body.randomness === null || body.randomness === ''
      ? ZEN_DEFAULT_RANDOMNESS
      : body.randomness
  );

  return { deckSize, onlyLowDiff, excludeUniversals, sort, order, randomness };
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

  const poolLimit = Math.max(parsed.deckSize, ZEN_CANDIDATE_POOL_CAP);
  const page = await getRatingListPage({
    offset: 0,
    limit: poolLimit,
    query: '',
    sort: parsed.sort,
    order: parsed.order,
    lowDiff: parsed.onlyLowDiff ? 'only' : 'show',
    fourVote: 'hide',
    hideRated: true,
    zeroClears: false,
    rankReady: false,
    vote: 'exclude',
    excludeUniversals: parsed.excludeUniversals,
    userId,
    levelIdsFilter: null,
  });

  const candidateIds: number[] = [];
  for (const row of page.results) {
    const id = Number((row as { id?: unknown }).id);
    if (!Number.isFinite(id) || id <= 0) continue;
    candidateIds.push(id);
  }

  const selectedIndices = sampleZenPoolIndices(
    candidateIds.length,
    parsed.deckSize,
    parsed.randomness
  );

  const cards: Record<string, unknown>[] = [];
  for (const idx of selectedIndices) {
    const id = candidateIds[idx];
    if (id == null) continue;
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
    excludeUniversals: parsed.excludeUniversals,
    randomness: parsed.randomness,
    dealtAt: new Date().toISOString(),
    cards,
  };
}

const MAX_REPORT_NOTE_LENGTH = 500;

function formatZenLevelTitle(level: Level): string {
  const artist = getArtistDisplayName(level) || level.artist || 'Unknown Artist';
  const songBase = getSongDisplayName(level) || getSongName(level) || level.song || 'Unknown Song';
  // getSongDisplayName only appends suffix when songObject is present; ensure suffix always shows.
  const song =
    level.suffix && !songBase.includes(level.suffix)
      ? `${songBase} ${level.suffix}`.trim()
      : songBase;
  return `${artist} - ${song}`;
}

export async function sendZenMediaReport(opts: {
  reporterId: string;
  reporterName: string;
  reporterAvatarUrl?: string | null;
  reporterPlayerId?: number | null;
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

  const siteUrl = String(clientUrlEnv || '').replace(/\/$/, '');

  const levelLink = siteUrl
    ? `${siteUrl}/levels/${opts.levelId}`
    : `/levels/${opts.levelId}`;
  const ratingLink = siteUrl
    ? `${siteUrl}/rating/${opts.levelId}`
    : `/rating/${opts.levelId}`;

  const profilePath = opts.reporterPlayerId
    ? `/profile/${opts.reporterPlayerId}`
    : `/profile/${opts.reporterId}`;
  const profileUrl = siteUrl ? `${siteUrl}${profilePath}` : profilePath;

  const level = await Level.findByPk(opts.levelId, {
    include: [
      { model: Difficulty, as: 'difficulty', required: false },
      { model: Song, as: 'songObject', required: false },
    ],
  });

  const title = level
    ? formatZenLevelTitle(level)
    : `Level #${opts.levelId}`;
  const difficultyName = level?.difficulty?.name || 'Unknown';
  const clears = typeof level?.clears === 'number' ? level.clears : null;
  const videoLink = level?.videoLink ? getPrimaryVideoLink(level.videoLink) : '';

  const botAvatar = process.env.BOT_AVATAR_URL || '';
  const hook = new Webhook({ url: webhookUrl, throwErrors: true });
  hook.setUsername('Zen Mode media report');
  if (botAvatar) {
    hook.setAvatar(botAvatar);
  }

  const embed = new MessageBuilder()
    .setAuthor(
      opts.reporterName,
      opts.reporterAvatarUrl || '',
      profileUrl
    )
    .setTitle(title)
    .setURL(levelLink)
    .setThumbnail(level?.difficulty?.icon || '')
    .setColor(0xdc3545)
    .setTimestamp()
    .addField(
      `Level #${opts.levelId}`,
      [
        `Difficulty: **${difficultyName}**`,
        clears != null ? `Clears: **${clears}**` : null,
        videoLink ? `Video: ${videoLink}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      false
    )
    .addField(
      'Links',
      `Level: ${levelLink}\nRating: ${ratingLink}`,
      false
    );

  if (note) {
    embed.addField('Note', note, false);
  }

  await hook.send(embed);
}
