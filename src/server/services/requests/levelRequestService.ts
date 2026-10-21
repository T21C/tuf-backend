import {Op, col, fn, type Transaction} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import Level from '@/models/levels/Level.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import Difficulty from '@/models/levels/Difficulty.js';
import Creator from '@/models/credits/Creator.js';
import Team from '@/models/credits/Team.js';
import Song from '@/models/songs/Song.js';
import Artist from '@/models/artists/Artist.js';
import LevelRequest from '@/models/levels/LevelRequest.js';
import LevelTag from '@/models/levels/LevelTag.js';
import Curation from '@/models/curations/Curation.js';
import CurationType from '@/models/curations/CurationType.js';
import User from '@/models/auth/User.js';
import Player from '@/models/players/Player.js';
import PlayerStats from '@/models/players/PlayerStats.js';
import Pass from '@/models/passes/Pass.js';
import {permissionFlags} from '@/config/constants.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {hasFlag} from '@/misc/utils/auth/permissionUtils.js';
import {safeTransactionRollback, sanitizeTextInput} from '@/misc/utils/Utility.js';
import {sseManager, SSE_SOURCES} from '@/misc/utils/server/sse.js';
import {isBannedUntilExpired, isPermissionBanActive} from '@/server/services/accounts/playerBanUtils.js';
import {notificationService} from '@/server/services/notifications/NotificationService.js';
import {NOTIFICATION_TYPES} from '@/server/services/notifications/types.js';
import {ensureOpenRating} from '@/server/services/ratings/openRatingService.js';
import {broadcastRatingUpsert, buildLevelUpdateSseData} from '@/server/services/ratings/ratingListService.js';
import {CacheInvalidation} from '@/server/middleware/cache.js';
import Rating from '@/models/levels/Rating.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {
  COMPLETED_LEVEL_REQUEST_STATUSES,
  INFO_CHANGE_KINDS,
  INFO_CHANGE_VALUE_MAX,
  LEVEL_REQUEST_REASON_MAX,
  LEVEL_REQUEST_TYPES,
  RATING_LINK_STATUSES,
  RERATE_COOLDOWN_STATUSES,
  TERMINAL_LEVEL_REQUEST_STATUSES,
  actionsForRequest,
  canonicalLevelRequestStatus,
  canonicalRequestCredits,
  collectLevelReferenceIds,
  creditRequestSignature,
  completedRequestsFilter,
  completionStatusForDifficultyChange,
  curationRequestIssue,
  curationRequestTypeForLevel,
  isCurationRequestType,
  isLevelRequestAction,
  isLevelRequestStatus,
  isLevelRequestType,
  normalizePositiveIdList,
  normalizePguRequest,
  openRequestTypesFor,
  resolveRerateRating,
  reasonWithRequester,
  requestTeamFromInput,
  rerateComparisonLabel,
  tagRequestIssue,
  rerateCooldownRemainingMs,
  type LevelRequestAction,
  type LevelRequestStatus,
  type LevelRequestType,
} from '@/misc/utils/data/levelRequestValidation.js';
import { loadSerializedAssignedTags } from '@/server/services/data/levelTagGroupService.js';
import { getArtistDisplayName } from '@/misc/utils/data/levelHelpers.js';
import {
  REQUEST_SEARCH_MAX_Q,
} from '@/misc/utils/data/levelRequestSearch.js';
import {
  levelRequestSearchFromQuery,
  requestSearchHasStatusField,
} from '@/server/services/requests/levelRequestSearch.js';
import {
  deleteLevelRequestDiscordPost,
  logRequestDiscordFailure,
  postCurationRequestEmbed,
  postRerateRequestThread,
  reopenLevelRequestDiscordThread,
} from '@/server/services/requests/levelRequestDiscord.js';
import {
  applyRatingThreadMode,
  ratingThreadWantsPing,
  voteThreadLabel,
} from '@/server/services/discord/ratingThread.js';

const sequelize = getSequelizeForModelGroup('levels');
const elasticsearchService = ElasticsearchService.getInstance();

export class LevelRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'LevelRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type Viewer = {
  id: string;
  playerId?: number | null;
  permissionFlags?: bigint | number | string | null;
};

function viewerFlags(user: Viewer | null | undefined): bigint {
  if (user?.permissionFlags == null || user.permissionFlags === '') return 0n;
  try {
    return BigInt(user.permissionFlags);
  } catch {
    return 0n;
  }
}

export function canViewRequestType(user: Viewer | null | undefined, type: LevelRequestType): boolean {
  if (!user) return false;
  if (hasFlag(viewerFlags(user), permissionFlags.SUPER_ADMIN)) return true;
  if (type === 'rerate') return hasFlag(viewerFlags(user), permissionFlags.RATER);
  if (type === 'curation' || type === 'curation_rerate') {
    return hasFlag(viewerFlags(user), permissionFlags.CURATOR) || hasFlag(viewerFlags(user), permissionFlags.HEAD_CURATOR);
  }
  return false;
}

export function canManageRequestType(user: Viewer | null | undefined, type: LevelRequestType): boolean {
  if (!user) return false;
  if (hasFlag(viewerFlags(user), permissionFlags.SUPER_ADMIN)) return true;
  if (type === 'curation' || type === 'curation_rerate') {
    return hasFlag(viewerFlags(user), permissionFlags.CURATOR) || hasFlag(viewerFlags(user), permissionFlags.HEAD_CURATOR);
  }
  return false;
}

function canSeeInternalNote(user: Viewer, request: LevelRequest): boolean {
  return canViewRequestType(user, request.type);
}

async function loadViewerPlayer(user: Viewer): Promise<Player | null> {
  if (!user.playerId) return null;
  return Player.findByPk(user.playerId, {attributes: ['id', 'bannedUntil', 'rerateRequestBannedUntil', 'isBanned']});
}

function assertAccountAllowed(user: Viewer, player: Player | null) {
  if (!hasFlag(viewerFlags(user), permissionFlags.EMAIL_VERIFIED)) {
    throw new LevelRequestError(403, 'email', 'Email verification is required');
  }
  if (isPermissionBanActive(viewerFlags(user), player?.bannedUntil ?? null)) {
    throw new LevelRequestError(403, 'account_ban', 'This account is banned');
  }
}

function assertRerateBanClear(user: Viewer, player: Player | null) {
  if (!hasFlag(viewerFlags(user), permissionFlags.RERATE_REQUEST_BANNED)) return;
  if (isBannedUntilExpired(player?.rerateRequestBannedUntil ?? null)) return;
  throw new LevelRequestError(403, 'rerate_ban', 'This account cannot submit rerate requests');
}

async function loadLevelOrThrow(levelId: number): Promise<Level> {
  const level = await Level.findByPk(levelId, {
    attributes: ['id', 'song', 'songId', 'suffix', 'artist', 'videoLink', 'dlLink', 'description', 'teamId', 'diffId', 'toRate', 'isDeleted', 'isHidden'],
    include: [{model: Difficulty, as: 'difficulty', attributes: ['id', 'name', 'icon', 'emoji'], required: false}],
  });
  if (!level) throw new LevelRequestError(404, 'missing_level', 'Level not found');
  if (level.isDeleted) throw new LevelRequestError(400, 'deleted', 'Deleted levels cannot be requested');
  if (level.isHidden) throw new LevelRequestError(400, 'hidden', 'Hidden levels cannot be requested');
  return level;
}

function assertNotOnRatingPage(level: Level) {
  if (level.toRate) throw new LevelRequestError(400, 'unsettled', 'This level is still on the rating page');
}

async function assertNoOpenRequest(levelId: number, type: LevelRequestType, userId?: string) {
  const open = await LevelRequest.findOne({
    where: {
      levelId,
      type: {[Op.in]: openRequestTypesFor(type)},
      status: {[Op.notIn]: TERMINAL_LEVEL_REQUEST_STATUSES},
    },
    attributes: ['id', 'requesterUserId'],
  });
  if (open) {
    throw new LevelRequestError(409, 'open', 'A request of this type is already open for this level', {
      own: Boolean(userId && open.requesterUserId === userId),
    });
  }
}

async function levelHasCuration(levelId: number): Promise<boolean> {
  const count = await Curation.count({where: {levelId}});
  return count > 0;
}

function assertCurationRequestSlot(type: LevelRequestType, hasCuration: boolean) {
  if (!isCurationRequestType(type)) return;
  const expected = curationRequestTypeForLevel(hasCuration);
  if (type === expected) return;
  if (hasCuration) {
    throw new LevelRequestError(400, 'has_curation', 'This level already has a curation');
  }
  throw new LevelRequestError(400, 'no_curation', 'This level has no curation yet');
}

async function assertRerateCooldown(levelId: number) {
  const recent = await LevelRequest.findOne({
    where: {
      levelId,
      type: 'rerate',
      status: {[Op.in]: RERATE_COOLDOWN_STATUSES},
      resolvedAt: {[Op.not]: null},
    },
    order: [['resolvedAt', 'DESC']],
    attributes: ['resolvedAt'],
  });
  const remaining = rerateCooldownRemainingMs(recent?.resolvedAt ?? null);
  if (remaining > 0) {
    throw new LevelRequestError(429, 'cooldown', 'This level can be requested again after the cooldown');
  }
}

function requestedRatingOf(request: LevelRequest): string {
  return normalizePguRequest(String(request.payload?.requestedRating || ''));
}

async function ratingPageReason(request: LevelRequest, fallback: string, transaction?: Transaction): Promise<string> {
  const requester = await User.findByPk(request.requesterUserId, {
    attributes: ['username'],
    transaction,
  });
  const base = request.reason?.trim() || fallback.trim();
  return reasonWithRequester(base, requester?.username || '');
}

function readOptionalNote(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return raw.trim().slice(0, 4000);
}

async function refreshRatingSurfaces(levelId: number) {
  try {
    await elasticsearchService.reindexLevels([levelId]);
    sseManager.broadcastToSources([SSE_SOURCES.rating], {
      type: 'levelUpdate',
      data: await buildLevelUpdateSseData(levelId),
    });
  } catch (error) {
    logger.error('Failed to refresh rating surfaces after a request action', error);
  }
}

async function publishRequestRating(request: LevelRequest) {
  await refreshRatingSurfaces(request.levelId);
  if (!request.linkedRatingId) return;
  await CacheInvalidation.invalidateTag('admin:ratings').catch((error) => {
    logger.error('Failed to invalidate rating cache after a request thread change', error);
  });
  await broadcastRatingUpsert(request.linkedRatingId, request.levelId);
}

async function syncRequestThreadMode(request: LevelRequest, mode: 'discord' | 'website') {
  const level = await Level.findByPk(request.levelId);
  if (!level?.toRate) return;
  const rating = request.linkedRatingId
    ? await Rating.findByPk(request.linkedRatingId)
    : null;
  if (rating?.confirmedAt != null) return;
  await applyRatingThreadMode(level, rating, mode);
}

async function openLevelOnRatingPage(
  levelId: number,
  rerateNum: string,
  rerateReason: string,
  transaction: Transaction,
) {
  const level = await Level.findByPk(levelId, {
    attributes: ['id', 'diffId', 'baseScore', 'toRate', 'isDeleted', 'isHidden'],
    include: [{model: Difficulty, as: 'difficulty', attributes: ['id', 'baseScore'], required: false}],
    transaction,
    lock: true,
  });
  if (!level) throw new LevelRequestError(404, 'missing_level', 'Level not found');
  if (level.isDeleted) throw new LevelRequestError(400, 'deleted', 'Deleted levels cannot be requested');
  if (level.isHidden) throw new LevelRequestError(400, 'hidden', 'Hidden levels cannot be requested');
  if (level.toRate) throw new LevelRequestError(409, 'unsettled', 'This level is still on the rating page');
  const opened = await ensureOpenRating(
    levelId,
    {
      lowDiff: /^[pP]\d/.test(rerateNum),
      requesterFR: rerateNum,
      averageDifficultyId: null,
      communityDifficultyId: null,
    },
    transaction,
  );
  await level.update({
    toRate: true,
    rerateNum,
    rerateReason: sanitizeTextInput(rerateReason),
    previousDiffId: level.diffId || 0,
    previousBaseScore: level.baseScore || level.difficulty?.baseScore || 0,
  }, {transaction});
  return opened.rating;
}

async function comparisonSnapshots(reason: string) {
  const ids = collectLevelReferenceIds(reason);
  if (ids.length === 0) return {ids, found: [] as {levelId: number; diffId: number | null; diffName: string | null}[]};
  const levels = await Level.findAll({
    where: {id: {[Op.in]: ids}},
    attributes: ['id', 'diffId', 'song', 'artist', 'suffix', 'toRate'],
    include: [{model: Difficulty, as: 'difficulty', attributes: ['name'], required: false}],
  });
  const byId = new Map(levels.map((level) => [level.id, level]));
  for (const id of ids) {
    const level = byId.get(id);
    if (!level?.toRate) continue;
    const label = rerateComparisonLabel(level.artist, level.song, level.suffix);
    throw new LevelRequestError(
      400,
      'comparison_rerating',
      `${label} is currently being rerated, it cannot be used for comparison`,
      {label, levelId: level.id},
    );
  }
  const found = levels.map((level) => ({
    levelId: level.id,
    diffId: level.diffId ?? null,
    diffName: level.difficulty?.name ?? null,
  }));
  return {ids, found};
}

async function currentCurationTypeIds(levelId: number): Promise<number[]> {
  const row = await Curation.findOne({
    where: {levelId},
    attributes: ['id'],
    include: [{
      model: CurationType,
      as: 'types',
      attributes: ['id'],
      through: {attributes: []},
      required: false,
    }],
  });
  const types = (row as (Curation & {types?: {id: number}[]}) | null)?.types || [];
  return [...new Set(types.map((type) => Number(type.id)).filter((id) => Number.isInteger(id) && id > 0))];
}

async function assignableLevelTagIds(levelId: number): Promise<number[]> {
  const tags = await loadSerializedAssignedTags(levelId);
  return tags
    .filter((tag) => tag.isCommunity !== true || tag.pinned === true)
    .map((tag) => Number(tag.id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

async function currentDisplayedArtist(level: Level): Promise<string> {
  const row = await Level.findByPk(level.id, {
    attributes: ['id', 'artist'],
    include: [{
      model: Song,
      as: 'songObject',
      attributes: ['id'],
      required: false,
      include: [{
        model: Artist,
        as: 'artists',
        attributes: ['id', 'name'],
        through: {attributes: []},
        required: false,
      }],
    }],
  });
  return getArtistDisplayName(row) || level.artist || '';
}

async function currentRequestCredits(level: Level) {
  const [credits, team] = await Promise.all([
    LevelCredit.findAll({
      where: {levelId: level.id},
      attributes: ['creatorId', 'role', 'isOwner', 'sortOrder'],
    }),
    level.teamId ? Team.findByPk(level.teamId, {attributes: ['id', 'name']}) : Promise.resolve(null),
  ]);
  return {
    credits: canonicalRequestCredits(credits.map((credit) => credit.get({plain: true}))) || [],
    team: team ? {id: team.id, name: team.name} : null,
  };
}

async function buildInfoChangePayload(body: Record<string, unknown>, level: Level): Promise<Record<string, unknown>> {
  const kind = body.kind;
  if (!INFO_CHANGE_KINDS.includes(kind as typeof INFO_CHANGE_KINDS[number])) {
    throw new LevelRequestError(400, 'kind', 'Choose what should change');
  }
  if (kind === 'song') {
    const songId = Number(body.songId);
    if (!Number.isInteger(songId) || songId <= 0) {
      throw new LevelRequestError(400, 'song', 'Choose an existing song');
    }
    const song = await Song.findByPk(songId, {attributes: ['id', 'name']});
    if (!song) throw new LevelRequestError(400, 'song', 'Choose an existing song');
    const suffix = typeof body.suffix === 'string' ? body.suffix.trim().slice(0, 255) : String(level.suffix || '').trim();
    const currentSuffix = String(level.suffix || '').trim();
    if (song.id === level.songId && suffix === currentSuffix) {
      throw new LevelRequestError(400, 'unchanged', 'This already matches the level');
    }
    return {kind, songId: song.id, songName: song.name, suffix};
  }
  if (kind === 'artist') {
    const artistId = Number(body.artistId);
    if (!Number.isInteger(artistId) || artistId <= 0) {
      throw new LevelRequestError(400, 'artist', 'Choose an existing artist');
    }
    const artist = await Artist.findByPk(artistId, {attributes: ['id', 'name']});
    if (!artist) throw new LevelRequestError(400, 'artist', 'Choose an existing artist');
    const current = await currentDisplayedArtist(level);
    if (artist.name.trim() === current.trim()) {
      throw new LevelRequestError(400, 'unchanged', 'This already matches the level');
    }
    return {kind, artistId: artist.id, artistName: artist.name};
  }
  if (kind === 'video' || kind === 'download' || kind === 'description' || kind === 'multiple') {
    const value = String(body.value ?? '').trim();
    if (!value) throw new LevelRequestError(400, 'value', 'Enter the new value');
    if (value.length > INFO_CHANGE_VALUE_MAX) {
      throw new LevelRequestError(400, 'value_length', 'That value must be at most 4000 characters');
    }
    const current = kind === 'video' ? level.videoLink : kind === 'download' ? level.dlLink : kind === 'description' ? level.description : null;
    if (current != null && value === String(current).trim()) {
      throw new LevelRequestError(400, 'unchanged', 'This already matches the level');
    }
    return {kind, value};
  }

  const credits = canonicalRequestCredits(body.credits);
  const team = requestTeamFromInput(body.team);
  if (!credits || team === undefined) {
    throw new LevelRequestError(400, 'credits', 'Choose a valid creator list');
  }
  const creatorIds = [...new Set(credits.map((credit) => credit.creatorId))];
  const creators = creatorIds.length
    ? await Creator.findAll({where: {id: {[Op.in]: creatorIds}}, attributes: ['id', 'name']})
    : [];
  if (creators.length !== creatorIds.length) {
    throw new LevelRequestError(400, 'credits', 'Choose a valid creator list');
  }
  const names = new Map(creators.map((creator) => [creator.id, creator.name]));
  let storedTeam = team;
  if (storedTeam?.id) {
    const row = await Team.findByPk(storedTeam.id, {attributes: ['id', 'name']});
    if (!row) throw new LevelRequestError(400, 'credits', 'Choose a valid creator list');
    storedTeam = {id: row.id, name: row.name};
  }
  const current = await currentRequestCredits(level);
  const nextSignature = creditRequestSignature(credits, storedTeam);
  const currentSignature = creditRequestSignature(current.credits, current.team);
  if (nextSignature === currentSignature) {
    throw new LevelRequestError(400, 'unchanged', 'This already matches the level');
  }
  return {
    kind,
    team: storedTeam,
    credits: credits.map((credit) => ({
      ...credit,
      name: names.get(credit.creatorId) || '',
    })),
  };
}

async function buildPayload(type: LevelRequestType, body: Record<string, unknown>, level: Level, reason: string): Promise<Record<string, unknown>> {
  if (type === 'rerate') {
    const specials = await Difficulty.findAll({
      where: {type: 'SPECIAL'},
      attributes: ['name'],
    });
    const requestedRating = resolveRerateRating(
      String(body.requestedRating ?? ''),
      specials.map((row) => row.name),
    );
    if (!requestedRating) {
      throw new LevelRequestError(400, 'rating', 'Requested rating must be a PGU difficulty, range, or special difficulty name');
    }
    const comparisons = await comparisonSnapshots(reason);
    return {
      requestedRating,
      frozenDiffId: level.diffId ?? null,
      frozenDiffName: level.difficulty?.name ?? null,
      comparisons: comparisons.found,
    };
  }

  if (type === 'info_change') return buildInfoChangePayload(body, level);

  if (type === 'tag') {
    if (!Array.isArray(body.targetTagIds)) {
      throw new LevelRequestError(400, 'tags', 'Choose the tags this level should have');
    }
    const targetTagIds = normalizePositiveIdList(body.targetTagIds);
    if (targetTagIds.length > 0) {
      const tags = await LevelTag.findAll({
        where: {id: {[Op.in]: targetTagIds}},
        attributes: ['id'],
      });
      if (tags.length !== targetTagIds.length) {
        throw new LevelRequestError(400, 'tags', 'Only existing tags can be requested');
      }
    }
    const currentIds = await assignableLevelTagIds(level.id);
    if (tagRequestIssue(targetTagIds, currentIds)) {
      throw new LevelRequestError(400, 'unchanged_tags', 'Selected tags already match the level');
    }
    return {targetTagIds};
  }

  if (type === 'curation' || type === 'curation_rerate') {
    const curationTypeIds = normalizePositiveIdList(body.curationTypeIds);
    if (curationTypeIds.length > 0) {
      const types = await CurationType.findAll({
        where: {id: {[Op.in]: curationTypeIds}},
        attributes: ['id'],
      });
      if (types.length !== curationTypeIds.length) {
        throw new LevelRequestError(400, 'curation_types', 'One or more curation types do not exist');
      }
    }
    const currentIds = type === 'curation_rerate' ? await currentCurationTypeIds(level.id) : [];
    const issue = curationRequestIssue(type, curationTypeIds, currentIds);
    if (issue === 'curation_empty') {
      throw new LevelRequestError(400, issue, 'Choose at least one curation type');
    }
    if (issue === 'unchanged_curation') {
      throw new LevelRequestError(400, issue, 'Selected types already match the level');
    }
    if (type === 'curation') return {curationTypeIds};
    const current = new Set(currentIds);
    const target = new Set(curationTypeIds);
    return {
      curationTypeIds,
      addCurationTypeIds: curationTypeIds.filter((id) => !current.has(id)),
      removeCurationTypeIds: currentIds.filter((id) => !target.has(id)),
    };
  }

  throw new LevelRequestError(400, 'type', 'Choose a request type');
}

function readReason(type: LevelRequestType, raw: unknown): string {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (reason.length > LEVEL_REQUEST_REASON_MAX) {
    throw new LevelRequestError(400, 'reason_length', 'Reason must be at most 1000 characters');
  }
  if (!reason && (type === 'rerate' || type === 'curation_rerate')) {
    throw new LevelRequestError(400, 'reason', 'A reason is required');
  }
  return reason;
}

async function actorDisplayName(user: Viewer | null | undefined, transaction?: Transaction): Promise<string | null> {
  if (!user?.id) return null;
  const row = await User.findByPk(user.id, {attributes: ['nickname', 'username'], transaction});
  const name = row?.nickname || row?.username || '';
  return name.trim() || null;
}

async function difficultyNameById(diffId: number | null | undefined, transaction?: Transaction): Promise<string | null> {
  if (diffId == null || !Number.isInteger(diffId)) return null;
  const row = await Difficulty.findByPk(diffId, {attributes: ['name'], transaction});
  return row?.name || null;
}

async function notifyRequester(
  request: LevelRequest,
  options?: {
    actor?: Viewer | null;
    event?: 'status' | 'note';
    transaction?: Transaction;
    settledDiffId?: number | null;
  },
) {
  const event = options?.event === 'note' ? 'note' : 'status';
  const status = canonicalLevelRequestStatus(request.status) || String(request.status);
  if (event === 'status' && (status === 'pending' || status === 'withdrawn')) return;

  const [level, actorName] = await Promise.all([
    Level.findByPk(request.levelId, {
      attributes: ['id', 'song', 'artist', 'suffix', 'diffId'],
      include: [{model: Difficulty, as: 'difficulty', attributes: ['name'], required: false}],
      transaction: options?.transaction,
    }),
    actorDisplayName(options?.actor, options?.transaction),
  ]);
  const previousDifficulty = typeof request.payload?.frozenDiffName === 'string'
    ? request.payload.frozenDiffName
    : null;
  const requestedRating = typeof request.payload?.requestedRating === 'string'
    ? request.payload.requestedRating
    : null;
  const settledDifficulty = await difficultyNameById(
    options?.settledDiffId ?? level?.diffId ?? null,
    options?.transaction,
  ) || level?.difficulty?.name || null;
  const includeNote = event === 'note' || status === 'rejected';

  await notificationService.notify({
    type: NOTIFICATION_TYPES.RequestUpdated,
    payload: {
      requestId: request.id,
      requestType: request.type,
      status,
      event,
      levelId: request.levelId,
      song: level?.song ?? null,
      artist: level?.artist ?? null,
      suffix: level?.suffix ?? null,
      publicNote: includeNote ? request.publicNote || null : null,
      actorName,
      requestedRating,
      previousDifficulty,
      settledDifficulty,
    },
    recipients: {userIds: [request.requesterUserId]},
    actorId: options?.actor?.id ?? null,
    transaction: options?.transaction,
  });
}

async function bestVisiblePass(requesterUserId: string, levelId: number, viewer: Viewer) {
  const requester = await User.findByPk(requesterUserId, {attributes: ['id', 'playerId']});
  if (!requester?.playerId) return null;
  const passes = await Pass.findAll({
    where: {
      playerId: requester.playerId,
      levelId,
      [Op.or]: [{isDeleted: false}, {isDeleted: null}],
    },
    attributes: ['id', 'scoreV2', 'accuracy', 'isHidden', 'playerId'],
  });
  const viewerIsOwner = viewer.playerId != null && viewer.playerId === requester.playerId;
  const viewerIsSuper = hasFlag(viewerFlags(viewer), permissionFlags.SUPER_ADMIN);
  const visible = passes.filter((pass) => !pass.isHidden || viewerIsOwner || viewerIsSuper);
  visible.sort((a, b) => (Number(b.scoreV2) || 0) - (Number(a.scoreV2) || 0));
  const best = visible[0];
  if (!best) return null;
  return {id: best.id, scoreV2: best.scoreV2, accuracy: best.accuracy};
}

async function requesterTopDiff(playerId: number | null | undefined) {
  if (!playerId) return null;
  const stats = await PlayerStats.findByPk(playerId, {
    attributes: ['id', 'topDiffId'],
    include: [{model: Difficulty, as: 'topDiff', attributes: ['id', 'name', 'icon'], required: false}],
  });
  const diff = stats?.topDiff;
  if (!diff?.id) return null;
  return {id: diff.id, name: diff.name, icon: diff.icon};
}

function withLastActor(user: Viewer, patch: Record<string, unknown> = {}) {
  return {...patch, lastActorUserId: user.id};
}

async function serializeUserPreview(userId: string | null | undefined) {
  if (!userId) return null;
  const row = await User.findByPk(userId, {
    attributes: ['id', 'username', 'nickname', 'playerId', 'avatarUrl', 'avatarIsGif'],
  });
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    playerId: row.playerId ?? null,
    avatarUrl: row.avatarUrl ?? null,
    avatarIsGif: row.avatarIsGif === true,
  };
}

export async function serializeLevelRequest(request: LevelRequest, viewer: Viewer, options?: {includePass?: boolean}) {
  const includeLevelCredits = request.type === 'info_change' || request.type === 'rerate';
  const level = await Level.findByPk(request.levelId, {
    attributes: ['id', 'song', 'songId', 'suffix', 'artist', 'videoLink', 'dlLink', 'description', 'teamId', 'diffId', 'isDeleted', 'isHidden'],
    include: [
      {model: Difficulty, as: 'difficulty', attributes: ['id', 'name', 'icon', 'emoji'], required: false},
      ...(includeLevelCredits ? [
        {model: Team, as: 'teamObject', attributes: ['id', 'name'], required: false},
        {
          model: LevelCredit,
          as: 'levelCredits',
          attributes: ['creatorId', 'role', 'isOwner', 'sortOrder'],
          required: false,
          include: [{model: Creator, as: 'creator', attributes: ['id', 'name'], required: false}],
        },
      ] : []),
    ],
  });
  const payload = request.payload || {};
  const comparisonIds = Array.isArray(payload.comparisons)
    ? payload.comparisons.map((row) => Number((row as {levelId?: number}).levelId)).filter((id) => id > 0)
    : [];
  const liveLevels = comparisonIds.length
    ? await Level.findAll({
        where: {id: {[Op.in]: comparisonIds}},
        attributes: ['id', 'diffId', 'song', 'artist', 'teamId'],
        include: [
          {model: Difficulty, as: 'difficulty', attributes: ['id', 'name', 'icon'], required: false},
          {model: Team, as: 'teamObject', attributes: ['id', 'name'], required: false},
          {
            model: LevelCredit,
            as: 'levelCredits',
            attributes: ['id', 'role', 'sortOrder'],
            required: false,
            include: [{model: Creator, as: 'creator', attributes: ['id', 'name'], required: false}],
          },
        ],
      })
    : [];
  const liveById = new Map(liveLevels.map((row) => [row.id, row]));
  const requester = await User.findByPk(request.requesterUserId, {
    attributes: ['id', 'username', 'nickname', 'playerId', 'avatarUrl', 'avatarIsGif'],
  });
  const showInternal = canSeeInternalNote(viewer, request) && viewer.id !== request.requesterUserId
    ? true
    : canSeeInternalNote(viewer, request) && (
        hasFlag(viewerFlags(viewer), permissionFlags.SUPER_ADMIN) ||
        hasFlag(viewerFlags(viewer), permissionFlags.RATER) ||
        hasFlag(viewerFlags(viewer), permissionFlags.CURATOR) ||
        hasFlag(viewerFlags(viewer), permissionFlags.HEAD_CURATOR)
      );
  const includeInternal = canSeeInternalNote(viewer, request) && (
    viewer.id !== request.requesterUserId ||
    hasFlag(viewerFlags(viewer), permissionFlags.SUPER_ADMIN) ||
    hasFlag(viewerFlags(viewer), permissionFlags.RATER) ||
    hasFlag(viewerFlags(viewer), permissionFlags.CURATOR) ||
    hasFlag(viewerFlags(viewer), permissionFlags.HEAD_CURATOR)
  );
  const levelTagIds = request.type === 'tag' ? await assignableLevelTagIds(request.levelId) : undefined;
  const levelCurationTypeIds = request.type === 'curation' || request.type === 'curation_rerate'
    ? await currentCurationTypeIds(request.levelId)
    : undefined;

  return {
    id: request.id,
    type: request.type,
    status: canonicalLevelRequestStatus(request.status) || request.status,
    availableActions: canManageRequestType(viewer, request.type)
      ? actionsForRequest(request.type, request.status, {
          discordMessageUrl: request.discordMessageUrl,
          discordPostError: request.discordPostError,
          discordThreadClosed: request.discordThreadClosed,
        })
      : [],
    reason: request.reason,
    publicNote: request.publicNote,
    internalNote: includeInternal ? request.internalNote : null,
    payload,
    immediateSettle: request.immediateSettle,
    discordMessageUrl: request.discordMessageUrl,
    discordThreadClosed: request.discordThreadClosed === true,
    discordPostError: canManageRequestType(viewer, request.type) || hasFlag(viewerFlags(viewer), permissionFlags.SUPER_ADMIN)
      ? request.discordPostError
      : null,
    linkedRatingId: request.linkedRatingId,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    resolvedAt: request.resolvedAt,
    level: level
      ? {
          id: level.id,
          song: level.song,
          artist: level.artist,
          diffId: level.diffId,
          isDeleted: level.isDeleted,
          isHidden: level.isHidden,
          missing: false,
          difficulty: level.difficulty
            ? {id: level.difficulty.id, name: level.difficulty.name, icon: level.difficulty.icon, emoji: level.difficulty.emoji}
            : null,
          ...(levelTagIds !== undefined ? {tagIds: levelTagIds} : {}),
          ...(levelCurationTypeIds !== undefined ? {curationTypeIds: levelCurationTypeIds} : {}),
          ...(request.type === 'info_change' ? {
            songId: level.songId ?? null,
            suffix: level.suffix || '',
            videoLink: level.videoLink || '',
            dlLink: level.dlLink || '',
            description: level.description || '',
            teamId: level.teamId ?? null,
            team: level.teamObject ? {id: level.teamObject.id, name: level.teamObject.name} : null,
            teamObject: level.teamObject ? {id: level.teamObject.id, name: level.teamObject.name} : null,
            levelCredits: (level.levelCredits || []).map((credit) => ({
              creatorId: credit.creatorId,
              role: credit.role,
              isOwner: credit.isOwner === true,
              sortOrder: credit.sortOrder,
              name: credit.creator?.name || '',
              creator: credit.creator ? {id: credit.creator.id, name: credit.creator.name} : null,
            })),
          } : {}),
          ...(request.type === 'rerate' ? {
            team: level.teamObject?.name || null,
            levelCredits: (level.levelCredits || []).map((credit) => ({
              creatorId: credit.creatorId,
              role: credit.role,
              sortOrder: credit.sortOrder,
              creator: credit.creator ? {id: credit.creator.id, name: credit.creator.name} : null,
            })),
          } : {}),
        }
      : {
          id: request.levelId,
          missing: true,
          ...(levelTagIds !== undefined ? {tagIds: levelTagIds} : {}),
          ...(levelCurationTypeIds !== undefined ? {curationTypeIds: levelCurationTypeIds} : {}),
        },
    comparisons: Array.isArray(payload.comparisons)
      ? payload.comparisons.map((row) => {
          const snap = row as {levelId: number; diffId: number | null; diffName: string | null};
          const live = liveById.get(Number(snap.levelId));
          return {
            levelId: snap.levelId,
            frozenDiffId: snap.diffId ?? null,
            frozenDiffName: snap.diffName ?? null,
            currentDiffId: live?.diffId ?? null,
            currentDiffName: live?.difficulty?.name ?? null,
            currentIcon: live?.difficulty?.icon ?? null,
            song: live?.song ?? null,
            artist: live?.artist ?? null,
            team: live?.team ?? null,
            credits: (live?.levelCredits || []).map((credit) => ({
              role: credit.role,
              sortOrder: credit.sortOrder,
              creator: credit.creator ? {name: credit.creator.name} : null,
            })),
            missing: !live,
          };
        })
      : [],
    requester: requester
      ? {
          id: requester.id,
          username: requester.username,
          nickname: requester.nickname,
          playerId: requester.playerId ?? null,
          avatarUrl: requester.avatarUrl ?? null,
          avatarIsGif: requester.avatarIsGif === true,
          topDiff: options?.includePass === false ? null : await requesterTopDiff(requester.playerId),
        }
      : {id: request.requesterUserId, username: null, nickname: null, playerId: null, avatarUrl: null, avatarIsGif: false, topDiff: null},
    bestPass: options?.includePass === false ? null : await bestVisiblePass(request.requesterUserId, request.levelId, viewer),
    lastActor: await serializeUserPreview(request.lastActorUserId),
    showInternal,
  };
}

export async function createLevelRequest(user: Viewer, levelId: number, body: Record<string, unknown>) {
  if (!isLevelRequestType(body.type)) {
    throw new LevelRequestError(400, 'type', 'Unknown request type');
  }
  const type = body.type;
  const player = await loadViewerPlayer(user);
  assertAccountAllowed(user, player);
  if (type === 'rerate') assertRerateBanClear(user, player);
  const level = await loadLevelOrThrow(levelId);
  if (type === 'rerate') assertNotOnRatingPage(level);
  if (isCurationRequestType(type)) {
    assertCurationRequestSlot(type, await levelHasCuration(levelId));
  }
  await assertNoOpenRequest(levelId, type, user.id);
  if (type === 'rerate') await assertRerateCooldown(levelId);
  const reason = readReason(type, body.reason);
  const payload = await buildPayload(type, body, level, reason);
  const request = await LevelRequest.create({
    type,
    levelId,
    requesterUserId: user.id,
    status: 'pending',
    reason,
    payload,
    immediateSettle: false,
  });
  return serializeLevelRequest(request, user);
}

export async function updateOwnLevelRequest(user: Viewer, requestId: number, body: Record<string, unknown>) {
  const request = await LevelRequest.findByPk(requestId);
  if (!request) throw new LevelRequestError(404, 'missing', 'Request not found');
  if (request.requesterUserId !== user.id) throw new LevelRequestError(403, 'forbidden', 'You cannot edit this request');
  if (request.status !== 'pending') throw new LevelRequestError(409, 'locked', 'Only a pending request can be edited');
  const level = await loadLevelOrThrow(request.levelId);
  if (request.type === 'rerate') assertNotOnRatingPage(level);
  if (isCurationRequestType(request.type)) {
    assertCurationRequestSlot(request.type, await levelHasCuration(request.levelId));
  }
  const reason = body.reason === undefined ? request.reason : readReason(request.type, body.reason);
  const nextBody = {...request.payload, ...body, reason};
  const payload = await buildPayload(request.type, nextBody, level, reason);
  if (request.type === 'rerate') {
    const previousFrozenId = request.payload?.frozenDiffId;
    const previousFrozenName = request.payload?.frozenDiffName;
    if (typeof previousFrozenId === 'number') payload.frozenDiffId = previousFrozenId;
    if (typeof previousFrozenName === 'string') payload.frozenDiffName = previousFrozenName;
  }
  await request.update({reason, payload});
  return serializeLevelRequest(request, user);
}

export async function withdrawLevelRequest(user: Viewer, requestId: number) {
  const request = await LevelRequest.findByPk(requestId);
  if (!request) throw new LevelRequestError(404, 'missing', 'Request not found');
  if (request.requesterUserId !== user.id) throw new LevelRequestError(403, 'forbidden', 'You cannot withdraw this request');
  if (request.status !== 'pending') throw new LevelRequestError(409, 'locked', 'Only a pending request can be withdrawn');
  const resolvedAt = new Date();
  await request.update({status: 'withdrawn', resolvedAt});
  return serializeLevelRequest(request, user);
}

export async function getLevelRequestForViewer(user: Viewer, requestId: number) {
  const request = await LevelRequest.findByPk(requestId);
  if (!request) throw new LevelRequestError(404, 'missing', 'Request not found');
  if (request.requesterUserId !== user.id && !canViewRequestType(user, request.type)) {
    throw new LevelRequestError(403, 'forbidden', 'You cannot view this request');
  }
  return serializeLevelRequest(request, user);
}

const LIST_SORTS: Record<string, [string, 'ASC' | 'DESC']> = {
  created_desc: ['createdAt', 'DESC'],
  created_asc: ['createdAt', 'ASC'],
  updated_desc: ['updatedAt', 'DESC'],
  updated_asc: ['updatedAt', 'ASC'],
};

function listLevelRequestOrder(raw: unknown): [[string, 'ASC' | 'DESC']] {
  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return [LIST_SORTS[key] || LIST_SORTS.created_desc];
}

export async function listOwnLevelRequests(user: Viewer, query: Record<string, unknown>) {
  return listLevelRequests(user, {...query, mine: true});
}

export async function countOpenLevelRequests(user: Viewer): Promise<Partial<Record<LevelRequestType, number>>> {
  const types = LEVEL_REQUEST_TYPES.filter((type) => canViewRequestType(user, type));
  const counts: Partial<Record<LevelRequestType, number>> = {};
  for (const type of types) counts[type] = 0;
  if (!types.length) return counts;
  const rows = await LevelRequest.findAll({
    attributes: ['type', [fn('COUNT', col('id')), 'openCount']],
    where: {
      type: {[Op.in]: types},
      status: 'pending',
    },
    group: ['type'],
    raw: true,
  }) as unknown as Array<{type: LevelRequestType; openCount: string | number}>;
  for (const row of rows) {
    if (!types.includes(row.type)) continue;
    counts[row.type] = Number(row.openCount) || 0;
  }
  return counts;
}

export async function listLevelRequests(user: Viewer, query: Record<string, unknown>) {
  const mine = query.mine === true;
  const limit = Math.min(50, Math.max(1, Number(query.limit) || 20));
  const offset = Math.max(0, Number(query.offset) || 0);
  const where: Record<string, unknown> = {};
  if (mine) {
    where.requesterUserId = user.id;
  } else if (isLevelRequestType(query.type)) {
    if (!canViewRequestType(user, query.type)) {
      throw new LevelRequestError(403, 'forbidden', 'You cannot view these requests');
    }
    where.type = query.type;
  } else {
    throw new LevelRequestError(400, 'type', 'A request type is required');
  }
  if (typeof query.type === 'string' && isLevelRequestType(query.type) && mine) {
    where.type = query.type;
  }
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, REQUEST_SEARCH_MAX_Q) : '';
  const search = q ? await levelRequestSearchFromQuery(q, mine) : {groups: [], where: null};
  if (search.where) {
    (where as Record<PropertyKey, unknown>)[Op.and] = [search.where];
  }
  if (typeof query.status === 'string' && isLevelRequestStatus(query.status)) {
    where.status = query.status;
  } else if (!requestSearchHasStatusField(search.groups)) {
    const completedMode = completedRequestsFilter(query);
    if (completedMode === 'hide') {
      where.status = {[Op.notIn]: COMPLETED_LEVEL_REQUEST_STATUSES};
    } else if (completedMode === 'only') {
      where.status = {[Op.in]: COMPLETED_LEVEL_REQUEST_STATUSES};
    }
  }
  if (query.levelId != null && String(query.levelId).trim() !== '') {
    const levelId = Number(query.levelId);
    if (!Number.isInteger(levelId) || levelId <= 0) {
      throw new LevelRequestError(400, 'level', 'Level id is invalid');
    }
    where.levelId = levelId;
  } else if (typeof query.level === 'string' && query.level.trim()) {
    const text = query.level.trim();
    if (/^\d+$/.test(text)) {
      where.levelId = Number(text);
    } else {
      const levels = await Level.findAll({
        where: {song: {[Op.like]: `%${text.slice(0, 80)}%`}},
        attributes: ['id'],
        limit: 50,
      });
      where.levelId = {[Op.in]: levels.map((level) => level.id).concat([-1])};
    }
  }
  if (typeof query.requester === 'string' && query.requester.trim()) {
    const users = await User.findAll({
      where: {username: {[Op.like]: `%${query.requester.trim().slice(0, 40)}%`}},
      attributes: ['id'],
      limit: 50,
    });
    where.requesterUserId = {[Op.in]: users.map((row) => row.id).concat(['00000000-0000-0000-0000-000000000000'])};
  }
  const rows = await LevelRequest.findAndCountAll({
    where,
    order: listLevelRequestOrder(query.sort),
    limit,
    offset,
  });
  const results = await Promise.all(rows.rows.map((row) => serializeLevelRequest(row, user, {includePass: false})));
  return {results, total: rows.count, limit, offset};
}

export async function levelRequestEligibility(user: Viewer, levelId: number) {
  const player = await loadViewerPlayer(user);
  const types: LevelRequestType[] = ['rerate', 'info_change', 'tag', 'curation', 'curation_rerate'];
  const result: Record<string, {allowed: boolean; code: string | null; own?: boolean}> = {};
  let level: Level | null = null;
  try {
    level = await loadLevelOrThrow(levelId);
  } catch (error) {
    const code = error instanceof LevelRequestError ? error.code : 'missing_level';
    for (const type of types) result[type] = {allowed: false, code};
    return result;
  }
  const hasCuration = await levelHasCuration(level.id);
  for (const type of types) {
    try {
      assertAccountAllowed(user, player);
      if (type === 'rerate') {
        assertRerateBanClear(user, player);
        await assertRerateCooldown(levelId);
        assertNotOnRatingPage(level);
      }
      if (isCurationRequestType(type)) assertCurationRequestSlot(type, hasCuration);
      await assertNoOpenRequest(level.id, type, user.id);
      result[type] = {allowed: true, code: null};
    } catch (error) {
      const own = error instanceof LevelRequestError && typeof error.details?.own === 'boolean'
        ? error.details.own
        : undefined;
      result[type] = {
        allowed: false,
        code: error instanceof LevelRequestError ? error.code : 'error',
        ...(own !== undefined ? {own} : {}),
      };
    }
  }
  return result;
}

export async function updateLevelRequestStaff(user: Viewer, requestId: number, body: Record<string, unknown>) {
  const request = await LevelRequest.findByPk(requestId);
  if (!request) throw new LevelRequestError(404, 'missing', 'Request not found');
  if (!canManageRequestType(user, request.type)) {
    throw new LevelRequestError(403, 'forbidden', 'You cannot update this request');
  }
  if (body.status !== undefined) {
    throw new LevelRequestError(400, 'status', 'Use request actions instead of setting a status');
  }
  const previousPublic = request.publicNote;
  const patch: Record<string, unknown> = {};
  if (body.publicNote !== undefined) patch.publicNote = readOptionalNote(body.publicNote) ?? null;
  if (body.internalNote !== undefined) patch.internalNote = readOptionalNote(body.internalNote) ?? null;
  if (Object.keys(patch).length === 0) {
    throw new LevelRequestError(400, 'notes', 'No notes to save');
  }
  await request.update(withLastActor(user, patch));
  if (patch.publicNote !== undefined && patch.publicNote !== previousPublic && request.publicNote) {
    await notifyRequester(request, {actor: user, event: 'note'});
  }
  return serializeLevelRequest(request, user);
}

export async function applyLevelRequestAction(user: Viewer, requestId: number, body: Record<string, unknown>) {
  const request = await LevelRequest.findByPk(requestId);
  if (!request) throw new LevelRequestError(404, 'missing', 'Request not found');
  if (!canManageRequestType(user, request.type)) {
    throw new LevelRequestError(403, 'forbidden', 'You cannot update this request');
  }
  if (!isLevelRequestAction(body.action)) {
    throw new LevelRequestError(400, 'action', 'Unknown request action');
  }
  const action = body.action;
  const ping = ratingThreadWantsPing(body);
  const allowed = actionsForRequest(request.type, request.status, {
    discordMessageUrl: request.discordMessageUrl,
    discordPostError: request.discordPostError,
    discordThreadClosed: request.discordThreadClosed,
  });
  if (!allowed.includes(action)) {
    throw new LevelRequestError(409, 'action', 'That action is not available for this request');
  }

  const publicNote = readOptionalNote(body.publicNote);
  const internalNote = readOptionalNote(body.internalNote);
  const notePatch: Record<string, unknown> = {};
  if (publicNote !== undefined) notePatch.publicNote = publicNote;
  if (internalNote !== undefined) notePatch.internalNote = internalNote;

  if (action === 'accept') {
    await request.update(withLastActor(user, {...notePatch, status: 'accepted', resolvedAt: null}));
    if (isCurationDiscordType(request.type) && !request.discordMessageUrl) {
      try {
        await postCurationDiscord(request);
      } catch (error) {
        if (!(error instanceof LevelRequestError) || error.code !== 'discord') throw error;
      }
    }
    await notifyRequester(request, {actor: user});
    return serializeLevelRequest(request, user);
  }

  if (action === 'reject') {
    await request.update(withLastActor(user, {
      ...notePatch,
      status: 'rejected',
      resolvedAt: request.resolvedAt || new Date(),
    }));
    await notifyRequester(request, {actor: user});
    return serializeLevelRequest(request, user);
  }

  if (action === 'complete') {
    let status: LevelRequestStatus = 'completed';
    let settledDiffId: number | null = null;
    if (request.type === 'rerate') {
      const level = await Level.findByPk(request.levelId, {attributes: ['id', 'diffId']});
      settledDiffId = level?.diffId ?? null;
      const frozen = request.payload?.frozenDiffId;
      status = completionStatusForDifficultyChange(
        typeof frozen === 'number' ? frozen : null,
        settledDiffId,
      );
    }
    await request.update(withLastActor(user, {
      ...notePatch,
      status,
      resolvedAt: request.resolvedAt || new Date(),
    }));
    await notifyRequester(request, {actor: user, settledDiffId});
    return serializeLevelRequest(request, user);
  }

  if (action === 'add_to_rating' || action === 'discord_vote') {
    const requested = requestedRatingOf(request);
    const rerateNum = action === 'discord_vote' ? voteThreadLabel(requested) : requested.slice(0, 60);
    const current = canonicalLevelRequestStatus(request.status);
    let transaction: Transaction | undefined;
    try {
      transaction = await sequelize.transaction();
      if (current === 'added_to_rating_page' && action === 'discord_vote') {
        const level = await Level.findByPk(request.levelId, {
          attributes: ['id', 'rerateNum', 'rerateReason', 'toRate'],
          transaction,
          lock: true,
        });
        if (!level) throw new LevelRequestError(404, 'missing_level', 'Level not found');
        const pageReason = await ratingPageReason(request, level.rerateReason || '', transaction);
        await level.update({
          rerateNum,
          rerateReason: sanitizeTextInput(pageReason),
        }, {transaction});
        if (!request.linkedRatingId) {
          const opened = await ensureOpenRating(
            request.levelId,
            {lowDiff: /^[pP]\d/.test(rerateNum), requesterFR: rerateNum},
            transaction,
          );
          await request.update(withLastActor(user, {linkedRatingId: opened.rating.id}), {transaction});
        }
      } else {
        const pageReason = await ratingPageReason(request, '', transaction);
        const rating = await openLevelOnRatingPage(request.levelId, rerateNum, pageReason, transaction);
        await request.update(withLastActor(user, {linkedRatingId: rating.id}), {transaction});
      }
      await request.update(withLastActor(user, {
        ...notePatch,
        status: action === 'discord_vote' ? 'discord_vote' : 'added_to_rating_page',
        immediateSettle: action === 'discord_vote' ? true : request.immediateSettle,
        resolvedAt: null,
      }), {transaction});
      await transaction.commit();
    } catch (error) {
      if (transaction) await safeTransactionRollback(transaction);
      throw error;
    }
    if (action === 'discord_vote') {
      await postRerateDiscord(request, user.id, ping);
    }
    await notifyRequester(request, {actor: user});
    if (action !== 'discord_vote') await refreshRatingSurfaces(request.levelId);
    return serializeLevelRequest(request, user);
  }

  if (action === 'retry_discord') {
    const curation = isCurationDiscordType(request.type);
    if (request.type !== 'rerate' && !curation) {
      throw new LevelRequestError(400, 'discord', 'Discord threads are only created for rerate requests');
    }
    await request.update(withLastActor(user, notePatch));
    if (curation) {
      await postCurationDiscord(request);
    } else {
      await postRerateDiscord(request, user.id, ping);
    }
    return serializeLevelRequest(request, user);
  }

  if (action === 'reopen_discord') {
    if (request.type !== 'rerate' || !request.discordMessageUrl) {
      throw new LevelRequestError(409, 'discord', 'This request has no Discord thread to reopen');
    }
    try {
      const outcome = await reopenLevelRequestDiscordThread(request, {actorUserId: user.id, ping});
      if (outcome === 'missing') throw new Error('Discord thread no longer exists');
    } catch (error) {
      if (error instanceof LevelRequestError) throw error;
      const message = logRequestDiscordFailure(request.id, error);
      throw new LevelRequestError(502, 'discord_reopen', message);
    }
    await syncRequestThreadMode(request, 'discord');
    await request.update(withLastActor(user, {...notePatch, discordThreadClosed: false, discordPostError: null}));
    await publishRequestRating(request);
    return serializeLevelRequest(request, user);
  }

  if (action === 'delete_discord') {
    if (!request.discordMessageUrl) {
      throw new LevelRequestError(409, 'discord', 'This request has no Discord post');
    }
    let outcome: 'closed' | 'removed';
    try {
      outcome = await deleteLevelRequestDiscordPost(request, {actorUserId: user.id, ping});
    } catch (error) {
      const message = logRequestDiscordFailure(request.id, error);
      const code = request.type === 'rerate' ? 'discord_close' : 'discord';
      throw new LevelRequestError(502, code, message);
    }
    if (request.type === 'rerate') {
      await syncRequestThreadMode(request, 'website');
      await request.update(withLastActor(user, outcome === 'closed'
        ? {...notePatch, discordThreadClosed: true, discordPostError: null}
        : {...notePatch, discordMessageUrl: null, discordThreadClosed: true, discordPostError: null}));
      await publishRequestRating(request);
      return serializeLevelRequest(request, user);
    }
    await request.update(withLastActor(user, {
      ...notePatch,
      discordMessageUrl: null,
      discordThreadClosed: false,
      discordPostError: null,
    }));
    return serializeLevelRequest(request, user);
  }

  throw new LevelRequestError(400, 'action', 'Unknown request action');
}

function isCurationDiscordType(type: string): boolean {
  return type === 'curation' || type === 'curation_rerate';
}

async function postCurationDiscord(request: LevelRequest) {
  const level = await Level.findByPk(request.levelId);
  if (!level) throw new LevelRequestError(404, 'missing_level', 'Level not found');
  try {
    const posted = await postCurationRequestEmbed(request, level);
    await request.update({discordMessageUrl: posted.url, discordPostError: null});
  } catch (error) {
    if (error instanceof LevelRequestError) throw error;
    const message = logRequestDiscordFailure(request.id, error);
    await request.update({discordPostError: message});
    throw new LevelRequestError(502, 'discord', message);
  }
}

async function postRerateDiscord(request: LevelRequest, actorUserId: string, ping = false) {
  const level = await Level.findByPk(request.levelId);
  if (!level) throw new LevelRequestError(404, 'missing_level', 'Level not found');
  try {
    const posted = await postRerateRequestThread(request, level, actorUserId, ping);
    await request.update({
      discordMessageUrl: posted.url,
      discordPostError: null,
      discordThreadClosed: false,
      lastActorUserId: actorUserId,
    });
  } catch (error) {
    const message = logRequestDiscordFailure(request.id, error);
    await request.update({discordPostError: message, lastActorUserId: actorUserId});
    throw new LevelRequestError(502, 'discord', message);
  }
  try {
    await syncRequestThreadMode(request, 'discord');
    await publishRequestRating(request);
  } catch (error) {
    logger.error('Failed to mark the rating page after a Discord thread was posted', error);
  }
}

export async function postLevelRequestDiscord(user: Viewer, requestId: number) {
  const request = await LevelRequest.findByPk(requestId);
  if (!request) throw new LevelRequestError(404, 'missing', 'Request not found');
  if (request.type !== 'rerate') {
    throw new LevelRequestError(400, 'discord', 'Discord threads are only created for rerate requests');
  }
  const action = canonicalLevelRequestStatus(request.status) === 'discord_vote' || request.discordMessageUrl
    ? 'retry_discord'
    : 'discord_vote';
  return applyLevelRequestAction(user, requestId, {action});
}

export async function attachOpenRatingToLevelRequest(
  levelId: number,
  ratingId: number,
  transaction?: Transaction,
) {
  const request = await LevelRequest.findOne({
    where: {
      levelId,
      type: 'rerate',
      linkedRatingId: null,
      status: {[Op.in]: RATING_LINK_STATUSES},
    },
    order: [['id', 'ASC']],
    transaction,
  });
  if (!request) return;
  await request.update({linkedRatingId: ratingId}, {transaction});
}

export async function completeLevelRequestForSettledRating(
  ratingId: number,
  settledDiffId: number | null,
  transaction?: Transaction,
  actorUserId?: string | null,
) {
  const request = await LevelRequest.findOne({
    where: {
      linkedRatingId: ratingId,
      type: 'rerate',
      status: {[Op.notIn]: TERMINAL_LEVEL_REQUEST_STATUSES},
    },
    transaction,
  });
  if (!request) return;
  const frozen = request.payload?.frozenDiffId;
  const status = completionStatusForDifficultyChange(
    typeof frozen === 'number' ? frozen : null,
    settledDiffId,
  );
  await request.update({
    status,
    resolvedAt: new Date(),
    ...(actorUserId ? {lastActorUserId: actorUserId} : {}),
  }, {transaction});
  await notifyRequester(request, {transaction, settledDiffId});
}

export async function levelRequestForRating(ratingId: number) {
  const request = await LevelRequest.findOne({
    where: {linkedRatingId: ratingId},
    order: [['id', 'DESC']],
  });
  if (!request) return null;
  return {
    id: request.id,
    type: request.type,
    status: canonicalLevelRequestStatus(request.status) || request.status,
    reason: request.reason,
    discordMessageUrl: request.discordMessageUrl,
    immediateSettle: request.immediateSettle,
    payload: request.payload,
  };
}

export async function rejectRecentOpenRerates(userId: string, since: Date, actorUserId?: string | null) {
  const rows = await LevelRequest.findAll({
    where: {
      requesterUserId: userId,
      type: 'rerate',
      status: {[Op.notIn]: TERMINAL_LEVEL_REQUEST_STATUSES},
      createdAt: {[Op.gte]: since},
    },
  });
  const note = 'Rerate requests were closed because this account is restricted from rerate requests.';
  for (const request of rows) {
    await request.update({
      status: 'rejected',
      publicNote: note,
      resolvedAt: new Date(),
      ...(actorUserId ? {lastActorUserId: actorUserId} : {}),
    });
    await notifyRequester(request);
  }
  return rows.length;
}

export function isRerateRequestBanActive(user: Viewer, bannedUntil: Date | string | null | undefined): boolean {
  if (!hasFlag(viewerFlags(user), permissionFlags.RERATE_REQUEST_BANNED)) return false;
  return !isBannedUntilExpired(bannedUntil ?? null);
}
