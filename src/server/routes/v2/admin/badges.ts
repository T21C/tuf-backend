import { Router, type Request, type Response } from 'express';
import { QueryTypes } from 'sequelize';
import { Auth } from '@/server/middleware/auth.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
import {
  BadgeDefinition,
  BadgeJob,
  BadgeReview,
  BadgeSet,
} from '@/models/badges/index.js';
import { enqueueBadgeJob, normalizeDefinition, type BadgeDraft } from '@/server/services/badges/index.js';
import { parseValueExpr } from '@/server/services/badges/engine/valueExpr.js';
import { parseBadgeConfig, validateBadgeConfig } from '@/server/services/badges/engine/importConfig.js';

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

router.use(Auth.superAdmin());

router.post('/formula', (req: Request, res: Response) => {
  const text = typeof req.body?.expression === 'string' ? req.body.expression : '';
  res.json(parseValueExpr(text));
});

router.get('/definitions', async (_req: Request, res: Response) => {
  const rows = await BadgeDefinition.findAll({ order: [['name', 'ASC']] });
  res.json({ definitions: rows });
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
  await enqueueBadgeJob({
    scope: 'definition',
    definitionId: created.id,
    replaceState: false,
  });
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
  await row.update(rowFields(normalized.value));
  await enqueueBadgeJob({
    scope: 'definition',
    definitionId: row.id,
    replaceState: req.body?.replace === true,
  });
  res.json({ definition: row });
});

router.post('/definitions/:id/recompute', async (req: Request, res: Response) => {
  const row = await BadgeDefinition.findByPk(Number(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Badge not found' });
    return;
  }
  await enqueueBadgeJob({
    scope: 'definition',
    definitionId: row.id,
    replaceState: req.body?.replace === true,
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
  if (pass[0]?.levelId) await enqueueBadgeJob({ scope: 'chart', levelId: Number(pass[0].levelId) });
  res.json({ review });
});

router.get('/jobs', async (_req: Request, res: Response) => {
  const jobs = await BadgeJob.findAll({ order: [['id', 'DESC']], limit: 30 });
  res.json({ jobs });
});

router.post('/backfill', async (req: Request, res: Response) => {
  const replace = req.body?.replace !== false;
  const startFrom = Math.max(0, Math.floor(Number(req.body?.startFrom) || 0));
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
  await enqueueBadgeJob({ scope: 'all', replaceState: replace, startFrom });
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
    for (const set of prepared.sets) {
      const existing = await BadgeSet.findOne({ where: { name: set.name }, transaction });
      if (existing) await existing.update({ kind: set.kind, values: set.values }, { transaction });
      else await BadgeSet.create({ name: set.name, kind: set.kind, values: set.values }, { transaction });
    }
    for (const definition of prepared.definitions) {
      const existing = await BadgeDefinition.findOne({ where: { slug: definition.slug }, transaction });
      const fields = rowFields(definition);
      if (existing) await existing.update(fields, { transaction });
      else await BadgeDefinition.create({ ...fields, publishedAt: new Date() }, { transaction });
    }
  });
  await enqueueBadgeJob({ scope: 'all', replaceState: req.body?.replace === true });
  res.json({ definitions: prepared.definitions.length, sets: prepared.sets.length });
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
