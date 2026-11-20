import { QueryTypes, type Transaction } from 'sequelize';
import Pass from '@/models/passes/Pass.js';
import { logger } from '@/server/services/core/LoggerService.js';

export function logBadgeFailure(scope: string, error: unknown): void {
  logger.error(`[badges] ${scope} failed`, error);
}

/** Freeze chart difficulty, scores, curation, and credits onto passes that do not have a snapshot yet. */
export async function snapshotMissingPasses(levelId: number, transaction?: Transaction): Promise<void> {
  const sequelize = Pass.sequelize;
  if (!sequelize) return;
  const missing = await sequelize.query<{ id: number }>(
    `SELECT p.id AS id
     FROM passes p
     LEFT JOIN pass_badge_snapshots s ON s.passId = p.id
     WHERE p.levelId = :levelId AND IFNULL(p.isDeleted, 0) = 0 AND s.passId IS NULL`,
    { replacements: { levelId }, transaction, type: QueryTypes.SELECT },
  );
  if (!missing.length) return;
  const level = await sequelize.query<{ diffId: number; baseScore: number | null; ppBaseScore: number | null }>(
    'SELECT diffId, baseScore, ppBaseScore FROM levels WHERE id = :levelId',
    { replacements: { levelId }, transaction, type: QueryTypes.SELECT },
  );
  const curation = await sequelize.query<{ id: number }>(
    `SELECT ct.id AS id
     FROM curations c
     INNER JOIN curation_curation_types j ON j.curationId = c.id
     INNER JOIN curation_types ct ON ct.id = j.typeId
     WHERE c.levelId = :levelId AND IFNULL(c.isDuplicate, 0) = 0`,
    { replacements: { levelId }, transaction, type: QueryTypes.SELECT },
  );
  const creditRows = await sequelize.query<{ creatorId: number; role: string }>(
    `SELECT creatorId, role FROM level_credits
     WHERE levelId = :levelId AND role IN ('charter', 'vfxer')`,
    { replacements: { levelId }, transaction, type: QueryTypes.SELECT },
  );
  const current = level[0];
  const curationTypeIds = JSON.stringify(curation.map((row) => Number(row.id)));
  const charterIds = JSON.stringify(creditRows.filter((row) => row.role === 'charter').map((row) => Number(row.creatorId)));
  const vfxerIds = JSON.stringify(creditRows.filter((row) => row.role === 'vfxer').map((row) => Number(row.creatorId)));
  for (const pass of missing) {
    await sequelize.query(
      `INSERT INTO pass_badge_snapshots
        (passId, diffId, baseScore, ppBaseScore, curationTypeIds, charterIds, vfxerIds, createdAt)
       VALUES (:passId, :diffId, :baseScore, :ppBaseScore, CAST(:curationTypeIds AS JSON), CAST(:charterIds AS JSON), CAST(:vfxerIds AS JSON), NOW())`,
      {
        replacements: {
          passId: Number(pass.id),
          diffId: current?.diffId ?? null,
          baseScore: current?.baseScore ?? null,
          ppBaseScore: current?.ppBaseScore ?? null,
          curationTypeIds,
          charterIds,
          vfxerIds,
        },
        transaction,
      },
    );
  }
}
