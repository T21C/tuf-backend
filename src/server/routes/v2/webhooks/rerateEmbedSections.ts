import { Op } from 'sequelize';
import Difficulty from '@/models/levels/Difficulty.js';
import Level from '@/models/levels/Level.js';
import Pass from '@/models/passes/Pass.js';
import Rating from '@/models/levels/Rating.js';
import { MessageBuilder } from '@/misc/webhook/index.js';
import { getVideoDetails } from '@/misc/utils/data/videoDetailParser.js';
import { clientUrlEnv } from '@/config/app.config.js';
import {
  type LevelAnnouncementCurveSnapshot,
  type LevelAnnouncementFacet,
  type LevelAnnouncementSnapshot,
} from '@/server/interfaces/models/index.js';
import {
  displayScoreFromXaccMultiplier,
  resolveScoreV2RatingBase,
  xaccMultiplier,
  XACC_CURVE_DEFAULTS,
  XACC_SITE_DEFAULT_PIN1_ACC,
  XACC_SITE_DEFAULT_PIN2_ACC,
} from '@/misc/utils/pass/scoreV2XaccCurve.js';
import { SCORE_V2_ZERO_MISS_MULTIPLIER } from '@/misc/utils/pass/CalcScore.js';

const placeHolder = 'https://soggy.cat/static/ssoggycat/main/images/soggycat.webp';
const SCORE_SAMPLE_EPS = 0.5;

function wrap(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  const chunks: string[] = [];
  let remaining = str;
  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf(' ', maxLength);
    if (splitIndex === -1 || splitIndex < maxLength - 10) splitIndex = maxLength;
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trim();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks.join('\n');
}

function formatNumber(num: number): string {
  return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function formatString(str: string): string {
  return str.replace(/\n/g, ' ');
}

export type RerateEmbedContext = {
  level: Level;
  facets: LevelAnnouncementFacet[];
  before: LevelAnnouncementSnapshot;
  after: LevelAnnouncementSnapshot;
};

type DifficultyRow = { id: number; name: string; emoji?: string; icon?: string; color?: string; baseScore?: number };

let difficultyCache: DifficultyRow[] | null = null;

async function loadDifficulties(): Promise<DifficultyRow[]> {
  if (!difficultyCache) {
    difficultyCache = await Difficulty.findAll().then(rows =>
      rows.map(d => d.dataValues as DifficultyRow),
    );
  }
  return difficultyCache ?? [];
}

function curveConfig(curve?: LevelAnnouncementCurveSnapshot | null) {
  if (!curve) return null;
  return { poleOffset: curve.poleOffset, topMultiplier: curve.topMultiplier };
}

export function scoreAtAccuracyFromSnapshot(
  accuracy: number,
  snapshot: LevelAnnouncementSnapshot,
  difficulties?: DifficultyRow[],
): number {
  const diffRow = difficulties?.find(d => d.id === snapshot.diffId);
  const baseScore =
    snapshot.baseScore ||
    snapshot.difficultyBaseScore ||
    diffRow?.baseScore ||
    0;
  const ppBaseScore = snapshot.ppBaseScore ?? null;
  const ratingBase = resolveScoreV2RatingBase(accuracy, baseScore, ppBaseScore);
  const mult = xaccMultiplier(accuracy, ratingBase, curveConfig(snapshot.curve));
  return displayScoreFromXaccMultiplier(
    mult,
    ratingBase,
    SCORE_V2_ZERO_MISS_MULTIPLIER,
  );
}

function pickRepresentativeAccuracies(sortedUnique: number[]): number[] {
  if (sortedUnique.length === 0) return [];
  if (sortedUnique.length <= 4) return sortedUnique;

  const picks = new Set<number>();
  picks.add(sortedUnique[0]);
  picks.add(sortedUnique[Math.floor(sortedUnique.length / 2)]);
  picks.add(sortedUnique[sortedUnique.length - 1]);

  const hasPerfect = sortedUnique.some(a => a >= 1 - 1e-9);
  if (hasPerfect) picks.add(1);

  return Array.from(picks).sort((a, b) => a - b).slice(0, 4);
}

async function sampleAccuraciesForLevel(levelId: number): Promise<number[]> {
  const passes = await Pass.findAll({
    where: { levelId, isDeleted: false, accuracy: { [Op.ne]: null } },
    attributes: ['accuracy'],
    order: [['accuracy', 'ASC']],
  });

  const unique = [...new Set(
    passes
      .map(p => p.accuracy)
      .filter((a): a is number => a != null && Number.isFinite(a)),
  )].sort((a, b) => a - b);

  if (unique.length > 0) {
    return pickRepresentativeAccuracies(unique);
  }

  return [
    XACC_CURVE_DEFAULTS.cutoff,
    XACC_SITE_DEFAULT_PIN1_ACC,
    XACC_SITE_DEFAULT_PIN2_ACC,
    1,
  ];
}

export type CurveScoreSampleLine = {
  accuracy: number;
  oldScore: number;
  newScore: number;
  playerName?: string;
};

export async function buildCurveScoreSampleLines(
  levelId: number,
  before: LevelAnnouncementSnapshot,
  after: LevelAnnouncementSnapshot,
): Promise<CurveScoreSampleLine[]> {
  const difficulties = await loadDifficulties();
  const accuracies = await sampleAccuraciesForLevel(levelId);
  const lines: CurveScoreSampleLine[] = [];

  for (const accuracy of accuracies) {
    const oldScore = scoreAtAccuracyFromSnapshot(accuracy, before, difficulties);
    const newScore = scoreAtAccuracyFromSnapshot(accuracy, after, difficulties);
    if (Math.abs(oldScore - newScore) < SCORE_SAMPLE_EPS) continue;
    lines.push({ accuracy, oldScore, newScore });
  }

  return lines;
}

export function formatCurveScoreSamplesSection(lines: CurveScoreSampleLine[]): string | null {
  if (lines.length === 0) return null;
  return lines
    .map(line => {
      const pct = (line.accuracy * 100).toFixed(2);
      return `${pct}% — **${formatNumber(line.oldScore)}** ➔ **${formatNumber(line.newScore)}**`;
    })
    .join('\n');
}

async function difficultyEmojiById(
  diffId: number | undefined,
  difficulties: DifficultyRow[],
  rating: Rating | null,
  isCurrent: boolean,
): Promise<string> {
  const diff = difficulties.find(d => d.id === diffId);
  if (!diff) return '';

  const estimatedEmoji =
    isCurrent && rating?.averageDifficultyId
      ? difficulties.find(d => d.id === rating.averageDifficultyId)?.emoji || ''
      : '';

  if (diff.name.startsWith('Q')) {
    return `${diff.emoji || ''}${estimatedEmoji ? ` ||${estimatedEmoji}||` : ''}`;
  }
  return diff.emoji || '';
}

export async function buildDiffTransitionSection(
  ctx: RerateEmbedContext,
  rating: Rating | null,
): Promise<{ title: string; value: string } | null> {
  if (!ctx.facets.includes('DIFF')) return null;

  const difficulties = await loadDifficulties();
  const prevEmoji = await difficultyEmojiById(ctx.before.diffId, difficulties, rating, false);
  const nextEmoji = await difficultyEmojiById(ctx.after.diffId, difficulties, rating, true);

  const prevBase =
    ctx.before.baseScore ||
    ctx.before.difficultyBaseScore ||
    difficulties.find(d => d.id === ctx.before.diffId)?.baseScore ||
    0;
  const nextBase =
    ctx.after.baseScore ||
    ctx.after.difficultyBaseScore ||
    difficulties.find(d => d.id === ctx.after.diffId)?.baseScore ||
    0;

  return {
    title: 'Rerate',
    value: `**${prevEmoji}** ➔ **${nextEmoji}**\n**${prevBase}**pp ➔ **${nextBase}**pp`,
  };
}

export async function buildBaseScoreOnlySection(
  ctx: RerateEmbedContext,
): Promise<{ title: string; value: string } | null> {
  if (!ctx.facets.includes('BASE_SCORE')) return null;
  if (ctx.facets.includes('DIFF')) return null;

  const difficulties = await loadDifficulties();
  const prevBase =
    ctx.before.baseScore ||
    ctx.before.difficultyBaseScore ||
    difficulties.find(d => d.id === ctx.before.diffId)?.baseScore ||
    0;
  const nextBase =
    ctx.after.baseScore ||
    ctx.after.difficultyBaseScore ||
    difficulties.find(d => d.id === ctx.after.diffId)?.baseScore ||
    0;
  if (prevBase === nextBase) return null;

  return {
    title: 'Base Score Update',
    value: `**${prevBase}**pp ➔ **${nextBase}**pp`,
  };
}

export function buildPpBaseScoreOnlySection(
  ctx: RerateEmbedContext,
): { title: string; value: string } | null {
  if (!ctx.facets.includes('PP_BASE_SCORE')) return null;

  const prevPp = ctx.before.ppBaseScore || 0;
  const nextPp = ctx.after.ppBaseScore || 0;
  if (prevPp === nextPp) return null;

  return {
    title: 'PP Base Score Update',
    value: `**${prevPp}**PP ➔ **${nextPp}**PP`,
  };
}

export async function buildCurveScoreSamplesField(
  ctx: RerateEmbedContext,
): Promise<{ title: string; value: string } | null> {
  if (!ctx.facets.includes('CURVE')) return null;

  const lines = await buildCurveScoreSampleLines(ctx.level.id, ctx.before, ctx.after);
  const formatted = formatCurveScoreSamplesSection(lines);
  if (!formatted) return null;

  return {
    title: 'Score Curve Update',
    value: formatted,
  };
}

export async function createRerateEmbedFromQueue(
  ctx: RerateEmbedContext,
): Promise<MessageBuilder> {
  const level = ctx.level.dataValues ?? ctx.level;
  const team = level.team ?? null;
  const charter = level.charter ?? null;
  const vfxer = level.vfxer ?? null;
  const comment = level.publicComments ? level.publicComments : '(Unspecified)';

  const videoInfo = level.videoLink
    ? await getVideoDetails(level.videoLink).catch(() => null)
    : null;

  const rating = await Rating.findOne({
    where: { levelId: level.id },
    order: [['confirmedAt', 'DESC']],
  });

  const embed = new MessageBuilder()
    .setColor(level.difficulty?.color || '#000000')
    .setAuthor(
      `${wrap(level.song || 'Unknown Song', 30)} — ${wrap(level.artist || 'Unknown Artist', 30)}`,
      '',
      `${clientUrlEnv}/levels/${level.id}`,
    )
    .setTitle(`ID: ${level.id}`)
    .setThumbnail(level.difficulty?.icon || placeHolder)
    .addField('', '', false);

  const diffSection = await buildDiffTransitionSection(ctx, rating);
  if (diffSection) {
    embed.addField(diffSection.title, diffSection.value, true);
  } else {
    const baseOnly = await buildBaseScoreOnlySection(ctx);
    if (baseOnly) {
      embed.addField(baseOnly.title, baseOnly.value, true);
    }
  }

  const ppOnly = buildPpBaseScoreOnlySection(ctx);
  if (ppOnly) {
    embed.addField(ppOnly.title, ppOnly.value, true);
  }

  const curveSection = await buildCurveScoreSamplesField(ctx);
  if (curveSection) {
    embed.addField(curveSection.title, curveSection.value, false);
  }

  embed.addField('', '', false);

  if (team) embed.addField('', `Team\n**${formatString(team)}**`, true);
  if (vfxer) embed.addField('', `VFX\n**${formatString(vfxer)}**`, true);
  if (charter) embed.addField('', `Chart\n**${formatString(charter)}**`, true);
  if (comment && level.difficulty?.name === 'Censored') {
    embed.addField('Reason', `**${formatString(comment)}**`, false);
  }

  embed
    .addField(
      '',
      `**${level.videoLink ? `[${wrap(videoInfo?.title || 'No title', 45)}](${level.videoLink})` : 'No video link'}**`,
      false,
    )
    .setFooter(`ID: ${level.id}`, '')
    .setTimestamp();

  return embed;
}

/** Legacy wrapper: builds queue context from level previous* columns. */
export async function createRerateEmbed(levelInfo: Level | null): Promise<MessageBuilder> {
  if (!levelInfo) {
    return new MessageBuilder().setDescription('No pass info available');
  }

  const level = levelInfo;
  const lv = level.dataValues ?? level;
  const facets: LevelAnnouncementFacet[] = [];
  if (lv.previousDiffId && lv.previousDiffId !== lv.diffId) facets.push('DIFF');

  const prevEffective =
    (lv.previousBaseScore ?? lv.baseScore) ||
    lv.previousDifficulty?.baseScore ||
    0;
  const nextEffective = lv.baseScore || lv.difficulty?.baseScore || 0;
  if (prevEffective !== nextEffective) {
    facets.push('BASE_SCORE');
  }
  if (facets.length === 0 && lv.previousDiffId) facets.push('DIFF');

  return createRerateEmbedFromQueue({
    level: levelInfo,
    facets,
    before: {
      diffId: lv.previousDiffId ?? lv.diffId,
      baseScore: lv.previousBaseScore ?? null,
      difficultyBaseScore: lv.previousDifficulty?.baseScore ?? null,
      ppBaseScore: lv.ppBaseScore,
    },
    after: {
      diffId: lv.diffId,
      baseScore: lv.baseScore ?? null,
      difficultyBaseScore: lv.difficulty?.baseScore ?? null,
      ppBaseScore: lv.ppBaseScore,
    },
  });
}
