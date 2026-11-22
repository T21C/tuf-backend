import { Router, type Request, type Response } from 'express';
import { QueryTypes } from 'sequelize';
import { Auth } from '@/server/middleware/auth.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
import { respondMysqlClientError } from '@/misc/utils/db/mysqlClientError.js';
import {
  BadgeDefinition,
  BadgeGroup,
  BadgeJob,
  BadgeReview,
  BadgeSet,
} from '@/models/badges/index.js';
import {
  clampOwnerRange,
  definitionExpression,
  enqueueBadgeJob,
  normalizeDefinition,
  ownerRangeFrom,
  parseOwnerBounds,
  parseOwnerKind,
  shouldEnqueueOnSave,
  type BadgeDraft,
} from '@/server/services/badges/index.js';
import { parseValueExpr } from '@/server/services/badges/engine/valueExpr.js';
import { planValueExpr, planSummary } from '@/server/services/badges/engine/planExpr.js';
import {
  parseBadgeConfig,
  validateBadgeConfig,
  type ImportedDefinition,
} from '@/server/services/badges/engine/importConfig.js';

const router = Router();

function db() {
  return getSequelizeForModelGroup('badges');
}

function definitionPayload(body: Record<string, unknown>) {
  return normalizeDefinition({
    audience: body.audience,
    slug: body.slug,
    name: body.name,
    secret: body.secret === true,
    enabled: body.enabled !== false,
    reducer: body.reducer,
    grant: body.grant,
    identity: body.identity,
    backfill: body.backfill,
    curve: body.curve,
    tierLabels: body.tierLabels,
    weight: body.weight,
    display: body.display,
    confirm: body.confirm,
    params: body.params,
  });
}

function rowFields(value: BadgeDraft) {
  return {
    audience: value.audience,
    slug: value.slug,
    name: value.name,
    secret: value.secret,
    enabled: value.enabled,
    reducer: value.reducer,
    grantMode: value.grant,
    identityMode: value.identity,
    backfill: value.backfill,
    curve: value.curve,
    tierLabels: value.tierLabels,
    weight: value.weight,
    display: value.display,
    confirmMode: value.confirm,
    params: value.params,
  };
}

const GROUP_NAME_MAX = 80;

function parseGroupName(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'Group name is required' };
  const name = raw.trim();
  if (!name) return { ok: false, error: 'Group name is required' };
  if (name.length > GROUP_NAME_MAX) return { ok: false, error: 'Group name is too long' };
  return { ok: true, value: name };
}

function parsePositiveInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

async function loadOwnerBounds(kind: 'player' | 'creator') {
  const table = kind === 'creator' ? 'creators' : 'players';
  const rows = await db().query<{ minId: number | null; maxId: number | null }>(
    `SELECT MIN(id) AS minId, MAX(id) AS maxId FROM ${table}`,
    { type: QueryTypes.SELECT },
  );
  return parseOwnerBounds(rows[0]);
}

function parseIdList(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    const id = parsePositiveInt(item);
    if (id == null || seen.has(id)) return null;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function parseSortOrders(raw: unknown): { id: number; sortOrder: number }[] | null {
  if (!Array.isArray(raw)) return null;
  const items: { id: number; sortOrder: number }[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const src = item as { id?: unknown; sortOrder?: unknown };
    const id = parsePositiveInt(src.id);
    const sortOrder = Number(src.sortOrder);
    if (id == null || !Number.isInteger(sortOrder) || seen.has(id)) return null;
    seen.add(id);
    items.push({ id, sortOrder });
  }
  return items;
}

type PlacementGroup = { id: number; badgeIds: number[] };

function parsePlacements(body: unknown): { ok: true; groups: PlacementGroup[]; ungrouped: number[] } | { ok: false; error: string } {
  const src = body && typeof body === 'object' ? (body as { groups?: unknown; ungrouped?: unknown }) : {};
  if (!Array.isArray(src.groups)) return { ok: false, error: 'groups must be an array' };
  const ungrouped = src.ungrouped === undefined ? [] : parseIdList(src.ungrouped);
  if (!ungrouped) return { ok: false, error: 'ungrouped must be an array of badge ids' };
  const groups: PlacementGroup[] = [];
  const seenGroups = new Set<number>();
  const seenBadges = new Set<number>(ungrouped);
  for (const item of src.groups) {
    if (!item || typeof item !== 'object') return { ok: false, error: 'Invalid group placement' };
    const row = item as { id?: unknown; badgeIds?: unknown };
    const id = parsePositiveInt(row.id);
    const badgeIds = parseIdList(row.badgeIds);
    if (id == null || seenGroups.has(id)) return { ok: false, error: 'Invalid group id' };
    if (!badgeIds) return { ok: false, error: 'badgeIds must be an array of unique badge ids' };
    for (const badgeId of badgeIds) {
      if (seenBadges.has(badgeId)) return { ok: false, error: 'A badge can only belong to one group' };
      seenBadges.add(badgeId);
    }
    seenGroups.add(id);
    groups.push({ id, badgeIds });
  }
  return { ok: true, groups, ungrouped };
}

router.use(Auth.superAdmin());

router.post('/formula', (req: Request, res: Response) => {
  const text = typeof req.body?.expression === 'string' ? req.body.expression : '';
  const parsed = parseValueExpr(text);
  if (!parsed.ok) {
    res.json(parsed);
    return;
  }
  const plan = planValueExpr(parsed.ast, { source: text });
  res.json({
    ok: true,
    ast: parsed.ast,
    plan: {
      ...planSummary(plan),
      demands: plan.demands.map((demand) => ({
        kind: demand.kind,
        key: demand.key,
        ...('label' in demand ? { label: demand.label } : {}),
        ...('field' in demand ? { field: demand.field } : {}),
      })),
    },
  });
});

router.get('/groups', async (_req: Request, res: Response) => {
  const groups = await BadgeGroup.findAll({ order: [['sortOrder', 'ASC'], ['name', 'ASC']] });
  res.json({ groups });
});

router.post('/groups', async (req: Request, res: Response) => {
  const parsed = parseGroupName(req.body?.name);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const existing = await BadgeGroup.findOne({ where: { name: parsed.value } });
    if (existing) {
      res.status(400).json({ error: 'A badge group with this name already exists' });
      return;
    }
    const maxSort = await BadgeGroup.max('sortOrder');
    const sortOrder = (typeof maxSort === 'number' ? maxSort : -1) + 1;
    const group = await BadgeGroup.create({ name: parsed.value, sortOrder });
    res.status(201).json({ group });
  } catch (error) {
    respondMysqlClientError(res, error, 'Failed to create badge group', {
      uniqueMessage: 'A badge group with this name already exists',
      logLabel: 'Create badge group failed:',
    });
  }
});

router.put('/groups/sort-orders', async (req: Request, res: Response) => {
  const sortOrders = parseSortOrders(req.body?.sortOrders);
  if (!sortOrders) {
    res.status(400).json({ error: 'sortOrders must be an array of { id, sortOrder }' });
    return;
  }
  try {
    await db().transaction(async (transaction) => {
      for (const item of sortOrders) {
        const [affected] = await BadgeGroup.update(
          { sortOrder: item.sortOrder },
          { where: { id: item.id }, transaction },
        );
        if (affected === 0) {
          throw Object.assign(new Error(`Badge group with ID ${item.id} not found`), { status: 400 });
        }
      }
    });
    const groups = await BadgeGroup.findAll({ order: [['sortOrder', 'ASC'], ['name', 'ASC']] });
    res.json({ groups });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 400) {
      res.status(400).json({ error: (error as Error).message });
      return;
    }
    respondMysqlClientError(res, error, 'Failed to update badge group sort orders', {
      logLabel: 'Update badge group sort orders failed:',
    });
  }
});

router.put('/groups/:id([0-9]{1,20})', async (req: Request, res: Response) => {
  const parsed = parseGroupName(req.body?.name);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const group = await BadgeGroup.findByPk(Number(req.params.id));
    if (!group) {
      res.status(404).json({ error: 'Badge group not found' });
      return;
    }
    if (parsed.value !== group.name) {
      const existing = await BadgeGroup.findOne({ where: { name: parsed.value } });
      if (existing) {
        res.status(400).json({ error: 'A badge group with this name already exists' });
        return;
      }
    }
    await group.update({ name: parsed.value });
    res.json({ group });
  } catch (error) {
    respondMysqlClientError(res, error, 'Failed to update badge group', {
      uniqueMessage: 'A badge group with this name already exists',
      logLabel: 'Update badge group failed:',
    });
  }
});

router.delete('/groups/:id([0-9]{1,20})', async (req: Request, res: Response) => {
  try {
    const group = await BadgeGroup.findByPk(Number(req.params.id));
    if (!group) {
      res.status(404).json({ error: 'Badge group not found' });
      return;
    }
    await group.destroy();
    res.json({ ok: true });
  } catch (error) {
    respondMysqlClientError(res, error, 'Failed to delete badge group', {
      logLabel: 'Delete badge group failed:',
    });
  }
});

router.get('/definitions', async (_req: Request, res: Response) => {
  const rows = await BadgeDefinition.findAll({ order: [['name', 'ASC']] });
  res.json({ definitions: rows });
});

router.put('/definitions/placements', async (req: Request, res: Response) => {
  const parsed = parsePlacements(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    await db().transaction(async (transaction) => {
      const groups = await BadgeGroup.findAll({ attributes: ['id'], transaction });
      const validGroups = new Set(groups.map((row) => row.id));
      for (const group of parsed.groups) {
        if (!validGroups.has(group.id)) {
          throw Object.assign(new Error(`Badge group with ID ${group.id} not found`), { status: 400 });
        }
      }
      const definitions = await BadgeDefinition.findAll({ attributes: ['id'], transaction });
      const expected = new Set(definitions.map((row) => row.id));
      const seen = new Set<number>();
      const take = (id: number) => {
        if (!expected.has(id) || seen.has(id)) {
          throw Object.assign(new Error('Invalid badge id in placements'), { status: 400 });
        }
        seen.add(id);
      };
      for (const group of parsed.groups) {
        for (const id of group.badgeIds) take(id);
      }
      for (const id of parsed.ungrouped) take(id);
      if (seen.size !== expected.size) {
        throw Object.assign(new Error('Every badge must appear in groups or ungrouped'), { status: 400 });
      }
      await Promise.all(
        parsed.ungrouped.map((id, index) =>
          BadgeDefinition.update({ groupId: null, sortOrder: index }, { where: { id }, transaction }),
        ),
      );
      await Promise.all(
        parsed.groups.flatMap((group) =>
          group.badgeIds.map((id, index) =>
            BadgeDefinition.update({ groupId: group.id, sortOrder: index }, { where: { id }, transaction }),
          ),
        ),
      );
    });
    const rows = await BadgeDefinition.findAll({ order: [['name', 'ASC']] });
    res.json({ definitions: rows });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 400) {
      res.status(400).json({ error: (error as Error).message });
      return;
    }
    respondMysqlClientError(res, error, 'Failed to update badge placements', {
      logLabel: 'Update badge placements failed:',
    });
  }
});

router.post('/definitions', async (req: Request, res: Response) => {
  const normalized = definitionPayload(req.body ?? {});
  if (!normalized.ok) {
    res.status(400).json({ error: normalized.errors.join(' ') });
    return;
  }
  const created = await BadgeDefinition.create({
    ...rowFields(normalized.value),
    publishedAt: new Date(),
  });
  if (shouldEnqueueOnSave({
    previousExpression: null,
    nextBackfill: normalized.value.backfill,
    nextParams: normalized.value.params,
  })) {
    await enqueueBadgeJob({
      scope: 'definition',
      definitionId: created.id,
      replaceState: false,
    });
  }
  res.status(201).json({ definition: created });
});

router.put('/definitions/:id', async (req: Request, res: Response) => {
  const row = await BadgeDefinition.findByPk(Number(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Badge not found' });
    return;
  }
  const normalized = definitionPayload(req.body ?? {});
  if (!normalized.ok) {
    res.status(400).json({ error: normalized.errors.join(' ') });
    return;
  }
  const previousExpression = definitionExpression(row.params);
  await row.update(rowFields(normalized.value));
  if (shouldEnqueueOnSave({
    previousExpression,
    nextBackfill: normalized.value.backfill,
    nextParams: normalized.value.params,
  })) {
    await enqueueBadgeJob({
      scope: 'definition',
      definitionId: row.id,
      replaceState: req.body?.replace === true,
    });
  }
  res.json({ definition: row });
});

router.post('/definitions/:id/recompute', async (req: Request, res: Response) => {
  const row = await BadgeDefinition.findByPk(Number(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Badge not found' });
    return;
  }
  const ownerKind = parseOwnerKind(req.body?.ownerKind) ?? (row.audience === 'creator' ? 'creator' : 'player');
  const range = clampOwnerRange(ownerRangeFrom(req.body ?? {}), await loadOwnerBounds(ownerKind));
  await enqueueBadgeJob({
    scope: 'definition',
    definitionId: row.id,
    replaceState: req.body?.replace === true,
    ownerFrom: range.ownerFrom,
    ownerTo: range.ownerTo,
    ownerKind,
  });
  res.json({ ok: true });
});

router.get('/sets', async (_req: Request, res: Response) => {
  const sets = await BadgeSet.findAll({ order: [['name', 'ASC']] });
  res.json({ sets });
});

router.post('/sets', async (req: Request, res: Response) => {
  const name = String(req.body?.name || '').trim();
  const kind = req.body?.kind === 'chart' ? 'chart' : 'difficulty';
  const values = Array.isArray(req.body?.values) ? req.body.values : [];
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    res.status(400).json({ error: 'Set name must be lowercase letters, numbers, and dashes' });
    return;
  }
  const created = await BadgeSet.create({ name, kind, values });
  await enqueueBadgeJob({ scope: 'all', replaceState: false });
  res.status(201).json({ set: created });
});

router.put('/sets/:id', async (req: Request, res: Response) => {
  const row = await BadgeSet.findByPk(Number(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Set not found' });
    return;
  }
  const kind = req.body?.kind === 'chart' ? 'chart' : row.kind;
  const values = Array.isArray(req.body?.values) ? req.body.values : row.values;
  await row.update({ kind, values });
  await enqueueBadgeJob({ scope: 'all', replaceState: false });
  res.json({ set: row });
});

router.delete('/sets/:id', async (req: Request, res: Response) => {
  const row = await BadgeSet.findByPk(Number(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Set not found' });
    return;
  }
  await row.destroy();
  res.json({ ok: true });
});

router.get('/reviews', async (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
  const reviews = await BadgeReview.findAll({
    where: { status },
    order: [['id', 'DESC']],
    limit: 100,
  });
  res.json({ reviews });
});

router.post('/reviews/:id/decision', async (req: Request, res: Response) => {
  const review = await BadgeReview.findByPk(Number(req.params.id));
  if (!review) {
    res.status(404).json({ error: 'Review not found' });
    return;
  }
  const decision = req.body?.decision === 'approved' ? 'approved' : req.body?.decision === 'rejected' ? 'rejected' : '';
  if (!decision) {
    res.status(400).json({ error: 'Decision must be approved or rejected' });
    return;
  }
  const videoUrl = typeof req.body?.videoUrl === 'string' ? req.body.videoUrl.trim() : review.videoUrl;
  if (decision === 'approved' && !videoUrl) {
    res.status(400).json({ error: 'An approved badge needs a video URL' });
    return;
  }
  await review.update({
    status: decision,
    videoUrl: videoUrl || '',
    reviewerId: req.user?.id ?? null,
    reviewedAt: new Date(),
  });
  const pass = await db().query<{ levelId: number }>(
    'SELECT levelId FROM passes WHERE id = :id',
    { replacements: { id: review.passId }, type: QueryTypes.SELECT },
  );
  if (pass[0]?.levelId) {
    await enqueueBadgeJob({
      scope: 'dirty',
      dirt: { levels: [Number(pass[0].levelId)] },
    });
  }
  res.json({ review });
});

router.get('/owner-bounds', async (_req: Request, res: Response) => {
  const [player, creator] = await Promise.all([
    loadOwnerBounds('player'),
    loadOwnerBounds('creator'),
  ]);
  res.json({ player, creator });
});

router.get('/jobs', async (_req: Request, res: Response) => {
  const recent = await BadgeJob.findAll({ order: [['id', 'DESC']], limit: 30 });
  const running = await BadgeJob.findOne({ where: { status: 'running' }, order: [['id', 'ASC']] });
  const oldestPending = running
    ? null
    : await BadgeJob.findOne({ where: { status: 'pending' }, order: [['id', 'ASC']] });
  const active = running || oldestPending;
  const jobs = active && !recent.some((job) => job.id === active.id)
    ? [active, ...recent]
    : recent;
  res.json({ jobs });
});

router.post('/backfill', async (req: Request, res: Response) => {
  const replace = req.body?.replace !== false;
  const ownerKind = parseOwnerKind(req.body?.ownerKind) ?? 'player';
  const range = clampOwnerRange(ownerRangeFrom(req.body ?? {}), await loadOwnerBounds(ownerKind));
  const busy = await db().query<{ id: number }>(
    `SELECT id FROM badge_jobs
     WHERE status IN ('pending', 'running')
     ORDER BY id ASC LIMIT 1`,
    { type: QueryTypes.SELECT },
  );
  if (busy[0]) {
    res.status(409).json({
      error: 'A backfill is already running. Cancel it before starting another.',
      jobId: Number(busy[0].id),
    });
    return;
  }
  await enqueueBadgeJob({
    scope: 'all',
    replaceState: replace,
    ownerFrom: range.ownerFrom,
    ownerTo: range.ownerTo,
    ownerKind,
  });
  const created = await db().query<{ id: number }>(
    `SELECT id FROM badge_jobs
     WHERE scope = 'all' AND replaceState = :replace AND status = 'pending'
     ORDER BY id DESC LIMIT 1`,
    { replacements: { replace: replace ? 1 : 0 }, type: QueryTypes.SELECT },
  );
  res.status(201).json({ jobId: created[0] ? Number(created[0].id) : null });
});

function affectedCount(result: unknown): number {
  if (typeof result === 'number') return result;
  if (Array.isArray(result)) {
    for (let index = result.length - 1; index >= 0; index -= 1) {
      const part = result[index];
      if (typeof part === 'number') return part;
      if (part && typeof part === 'object' && 'affectedRows' in part) {
        return Number((part as { affectedRows: number }).affectedRows) || 0;
      }
    }
  }
  if (result && typeof result === 'object' && 'affectedRows' in result) {
    return Number((result as { affectedRows: number }).affectedRows) || 0;
  }
  return 0;
}

router.post('/jobs/:id/cancel', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Job id is required' });
    return;
  }
  const updated = await db().query(
    `UPDATE badge_jobs
     SET status = 'cancelled', phase = 'cancelled', finishedAt = NOW()
     WHERE id = :id AND status IN ('pending', 'running')`,
    { replacements: { id }, type: QueryTypes.UPDATE },
  );
  if (affectedCount(updated) > 0) {
    res.json({ ok: true, status: 'cancelled' });
    return;
  }
  const rows = await db().query<{ status: string }>(
    'SELECT status FROM badge_jobs WHERE id = :id',
    { replacements: { id }, type: QueryTypes.SELECT },
  );
  const status = rows[0]?.status;
  if (!status) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  if (status === 'cancelled') {
    res.json({ ok: true, status: 'cancelled' });
    return;
  }
  res.status(409).json({ error: 'That job has already finished', status });
});

router.get('/jobs/:id/timings.csv', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const rows = await db().query<{ definitionTimings: { name?: string; audience?: string; runs?: number; totalMs?: number }[] | null }>(
    'SELECT definitionTimings FROM badge_jobs WHERE id = :id',
    { replacements: { id }, type: QueryTypes.SELECT },
  );
  const timings = Array.isArray(rows[0]?.definitionTimings) ? rows[0].definitionTimings : [];
  const ranked = [...timings].sort((a, b) => Number(b.totalMs) - Number(a.totalMs));
  const cell = (value: unknown) => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [
    'badge,audience,runs,totalMs,avgMs',
    ...ranked.map((row) => {
      const runs = Number(row.runs) || 0;
      const totalMs = Number(row.totalMs) || 0;
      const avg = runs > 0 ? Math.round(totalMs / runs) : 0;
      return [cell(row.name), cell(row.audience), runs, Math.round(totalMs), avg].join(',');
    }),
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="badge-backfill-${id}.csv"`);
  res.send(lines.join('\n'));
});

function importPlacement(
  definition: ImportedDefinition,
  groupMap: Map<number, number>,
  knownGroupIds: Set<number>,
) {
  let groupId = definition.groupId;
  if (groupId != null && groupMap.has(groupId)) groupId = groupMap.get(groupId) ?? null;
  if (groupId != null && !knownGroupIds.has(groupId)) groupId = null;
  return {
    ...(groupId !== undefined ? { groupId } : {}),
    ...(definition.sortOrder !== undefined ? { sortOrder: definition.sortOrder } : {}),
  };
}

router.get('/export', async (_req: Request, res: Response) => {
  const [groups, sets, definitions] = await Promise.all([
    BadgeGroup.findAll({ order: [['sortOrder', 'ASC'], ['name', 'ASC']] }),
    BadgeSet.findAll({ order: [['name', 'ASC']] }),
    BadgeDefinition.findAll({ order: [['name', 'ASC']] }),
  ]);
  res.json({ groups, sets, definitions });
});

router.post('/import', async (req: Request, res: Response) => {
  const parsed = parseBadgeConfig(typeof req.body?.code === 'string' ? req.body.code : '');
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.errors.join(' ') });
    return;
  }
  const names = [...new Set(parsed.document.definitions.flatMap((definition) => {
    const params = definition.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) return [];
    const packName = (params as { packName?: unknown }).packName;
    return typeof packName === 'string' && packName.trim() ? [packName.trim()] : [];
  }))];
  const found = names.length
    ? await db().query<{ id: number; name: string }>(
      'SELECT id, name FROM level_packs WHERE LOWER(name) IN (:names)',
      { replacements: { names: names.map((name) => name.toLowerCase()) }, type: QueryTypes.SELECT },
    )
    : [];
  const packIds: Record<string, number> = {};
  for (const pack of found) {
    const requested = names.find((name) => name.toLowerCase() === pack.name.toLowerCase());
    if (requested) packIds[requested] = Number(pack.id);
  }
  const prepared = validateBadgeConfig(parsed.document, packIds);
  if (!prepared.ok) {
    res.status(400).json({ error: prepared.errors.slice(0, 8).join(' ') });
    return;
  }
  await db().transaction(async (transaction) => {
    const groupMap = new Map<number, number>();
    for (const group of prepared.groups) {
      let existing = await BadgeGroup.findOne({ where: { name: group.name }, transaction });
      if (existing) {
        if (existing.sortOrder !== group.sortOrder) {
          await existing.update({ sortOrder: group.sortOrder }, { transaction });
        }
      } else {
        existing = await BadgeGroup.create({ name: group.name, sortOrder: group.sortOrder }, { transaction });
      }
      if (group.id != null) groupMap.set(group.id, existing.id);
    }
    const knownGroupIds = new Set(
      (await BadgeGroup.findAll({ attributes: ['id'], transaction })).map((group) => group.id),
    );
    for (const set of prepared.sets) {
      const existing = await BadgeSet.findOne({ where: { name: set.name }, transaction });
      if (existing) await existing.update({ kind: set.kind, values: set.values }, { transaction });
      else await BadgeSet.create({ name: set.name, kind: set.kind, values: set.values }, { transaction });
    }
    for (const definition of prepared.definitions) {
      const existing = await BadgeDefinition.findOne({ where: { slug: definition.slug }, transaction });
      const fields = {
        ...rowFields(definition),
        ...importPlacement(definition, groupMap, knownGroupIds),
      };
      if (existing) await existing.update(fields, { transaction });
      else await BadgeDefinition.create({ ...fields, publishedAt: new Date() }, { transaction });
    }
  });
  if (req.body?.replace === true) {
    await enqueueBadgeJob({ scope: 'all', replaceState: true });
  }
  res.json({
    definitions: prepared.definitions.length,
    sets: prepared.sets.length,
    groups: prepared.groups.length,
  });
});

router.get('/packs', async (req: Request, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const packs = await db().query<{ id: number; name: string }>(
    `SELECT id, name FROM level_packs
     WHERE :q = '' OR name LIKE :like
     ORDER BY name ASC
     LIMIT 20`,
    { replacements: { q, like: `%${q}%` }, type: QueryTypes.SELECT },
  );
  res.json({ packs });
});

export default router;
