import {QueryTypes} from 'sequelize';
import sequelize from '@/config/db.js';

/** C-family names: `C` or `C` + digits. */
export const SQL_C_FAMILY_NAME = `TRIM(ct.name) REGEXP '^[Cc][0-9]*$'`;
/** O-family names: `O` or `O` + digits. Grouped by shareChart (same toggle as C). */
export const SQL_O_FAMILY_NAME = `TRIM(ct.name) REGEXP '^[Oo][0-9]*$'`;
/** V-family names: `V` or `V` + digits. */
export const SQL_V_FAMILY_NAME = `TRIM(ct.name) REGEXP '^[Vv][0-9]*$'`;

type ShareFamily = 'C' | 'O' | 'V';

export function sqlCurationFamilyTier(nameExpr: string, letter: ShareFamily): string {
  const lower = letter.toLowerCase();
  return `CAST(CASE
    WHEN TRIM(${nameExpr}) REGEXP '^[${letter}${lower}][0-9]+$' THEN SUBSTRING(TRIM(${nameExpr}), 2)
    WHEN UPPER(TRIM(${nameExpr})) = '${letter}' THEN '0'
    ELSE NULL
  END AS UNSIGNED)`;
}

function sqlShareFamilyKeepsRow(
  creatorIdSql: string,
  family: ShareFamily,
): string {
  const shareCol = family === 'V' ? 'shareVfx' : 'shareChart';
  const role = family === 'V' ? 'vfxer' : 'charter';
  const familyRe =
    family === 'C' ? `'^[Cc][0-9]*$'` : family === 'O' ? `'^[Oo][0-9]*$'` : `'^[Vv][0-9]*$'`;
  const familyPred =
    family === 'C' ? SQL_C_FAMILY_NAME : family === 'O' ? SQL_O_FAMILY_NAME : SQL_V_FAMILY_NAME;
  const otherTier = sqlCurationFamilyTier('cto.name', family);
  const selfTier = sqlCurationFamilyTier('cts.name', family);

  return `(
    NOT (${familyPred})
    OR NOT EXISTS (
      SELECT 1 FROM level_link_members llm_share
      INNER JOIN level_link_groups llg_share
        ON llg_share.id = llm_share.groupId AND IFNULL(llg_share.${shareCol}, 0) = 1
      WHERE llm_share.levelId = c.levelId
    )
    OR NOT EXISTS (
      SELECT 1
      FROM level_link_members llm_self
      INNER JOIN level_link_groups llg
        ON llg.id = llm_self.groupId AND IFNULL(llg.${shareCol}, 0) = 1
      INNER JOIN level_link_members llm_other
        ON llm_other.groupId = llm_self.groupId
        AND llm_other.levelId <> c.levelId
      INNER JOIN levels lo
        ON lo.id = llm_other.levelId AND IFNULL(lo.isDeleted, 0) = 0
      INNER JOIN level_credits lco
        ON lco.levelId = llm_other.levelId
        AND lco.creatorId = ${creatorIdSql}
        AND lco.role = '${role}'
      INNER JOIN curations co
        ON co.levelId = llm_other.levelId AND IFNULL(co.isDuplicate, 0) = 0
      INNER JOIN curation_curation_types ccto ON ccto.curationId = co.id
      INNER JOIN curation_types cto
        ON cto.id = ccto.typeId AND TRIM(cto.name) REGEXP ${familyRe}
      WHERE llm_self.levelId = c.levelId
      GROUP BY llm_other.levelId
      HAVING
        MAX(${otherTier}) > (
          SELECT MAX(${selfTier})
          FROM curations cs
          INNER JOIN curation_curation_types ccts ON ccts.curationId = cs.id
          INNER JOIN curation_types cts
            ON cts.id = ccts.typeId AND TRIM(cts.name) REGEXP ${familyRe}
          WHERE cs.levelId = c.levelId AND IFNULL(cs.isDuplicate, 0) = 0
        )
        OR (
          MAX(${otherTier}) = (
            SELECT MAX(${selfTier})
            FROM curations cs
            INNER JOIN curation_curation_types ccts ON ccts.curationId = cs.id
            INNER JOIN curation_types cts
              ON cts.id = ccts.typeId AND TRIM(cts.name) REGEXP ${familyRe}
            WHERE cs.levelId = c.levelId AND IFNULL(cs.isDuplicate, 0) = 0
          )
          AND llm_other.levelId < c.levelId
        )
    )
  )`;
}

/**
 * Keep a curation-type row unless it is a C/O/V family type on a losing member
 * of a shareChart (C and O) / shareVfx (V) link group for this creator.
 * Outer query must alias curations as `c` and curation_types as `ct`.
 */
export function sqlLinkedShareKeepsTypeRow(creatorIdSql: string): string {
  return `(
    ${sqlShareFamilyKeepsRow(creatorIdSql, 'C')}
    AND ${sqlShareFamilyKeepsRow(creatorIdSql, 'O')}
    AND ${sqlShareFamilyKeepsRow(creatorIdSql, 'V')}
  )`;
}

export type LinkedShareContext = {
  shareChartLevelIds: Set<number>;
  shareVfxLevelIds: Set<number>;
  chartWinners: Map<number, Set<number>>;
  oWinners: Map<number, Set<number>>;
  vfxWinners: Map<number, Set<number>>;
};

const emptyShareContext = (): LinkedShareContext => ({
  shareChartLevelIds: new Set(),
  shareVfxLevelIds: new Set(),
  chartWinners: new Map(),
  oWinners: new Map(),
  vfxWinners: new Map(),
});

export function isCurationFamilyName(
  name: string | null | undefined,
  family: ShareFamily,
): boolean {
  const s = String(name ?? '').trim();
  if (family === 'C') return /^[Cc][0-9]*$/.test(s);
  if (family === 'O') return /^[Oo][0-9]*$/.test(s);
  return /^[Vv][0-9]*$/.test(s);
}

export function shouldKeepLinkedShareType(
  ctx: LinkedShareContext,
  creatorId: number,
  levelId: number,
  typeName: string | null | undefined,
): boolean {
  if (isCurationFamilyName(typeName, 'C') && ctx.shareChartLevelIds.has(levelId)) {
    return ctx.chartWinners.get(creatorId)?.has(levelId) === true;
  }
  if (isCurationFamilyName(typeName, 'O') && ctx.shareChartLevelIds.has(levelId)) {
    return ctx.oWinners.get(creatorId)?.has(levelId) === true;
  }
  if (isCurationFamilyName(typeName, 'V') && ctx.shareVfxLevelIds.has(levelId)) {
    return ctx.vfxWinners.get(creatorId)?.has(levelId) === true;
  }
  return true;
}

type ShareTierRow = {
  creatorId: number;
  groupId: number;
  levelId: number;
  shareChart: number | boolean;
  shareVfx: number | boolean;
  chartTier: number | null;
  oTier: number | null;
  vfxTier: number | null;
};

function addWinner(map: Map<number, Set<number>>, creatorId: number, levelId: number): void {
  const set = map.get(creatorId) ?? new Set<number>();
  set.add(levelId);
  map.set(creatorId, set);
}

function pickWinners(
  rows: ShareTierRow[],
  family: 'chart' | 'o' | 'vfx',
): Map<number, Set<number>> {
  const best = new Map<string, {tier: number; levelId: number; creatorId: number}>();
  for (const row of rows) {
    const enabled = family === 'vfx' ? row.shareVfx : row.shareChart;
    const tier =
      family === 'chart' ? row.chartTier : family === 'o' ? row.oTier : row.vfxTier;
    if (!enabled || tier == null || !Number.isFinite(Number(tier))) continue;
    const key = `${row.creatorId}:${row.groupId}`;
    const numericTier = Number(tier);
    const prev = best.get(key);
    if (
      !prev ||
      numericTier > prev.tier ||
      (numericTier === prev.tier && row.levelId < prev.levelId)
    ) {
      best.set(key, {tier: numericTier, levelId: row.levelId, creatorId: row.creatorId});
    }
  }
  const winners = new Map<number, Set<number>>();
  for (const entry of best.values()) {
    addWinner(winners, entry.creatorId, entry.levelId);
  }
  return winners;
}

export async function fetchLinkedShareContext(
  creatorIds: number[],
): Promise<LinkedShareContext> {
  const ctx = emptyShareContext();
  const ids = [...new Set(creatorIds)].filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) return ctx;

  const cTier = sqlCurationFamilyTier('ct.name', 'C');
  const oTier = sqlCurationFamilyTier('ct.name', 'O');
  const vTier = sqlCurationFamilyTier('ct.name', 'V');
  const rows = (await sequelize.query(
    `
    SELECT
      lc.creatorId AS creatorId,
      llm.groupId AS groupId,
      llm.levelId AS levelId,
      llg.shareChart AS shareChart,
      llg.shareVfx AS shareVfx,
      MAX(CASE WHEN TRIM(ct.name) REGEXP '^[Cc][0-9]*$' AND lc.role = 'charter'
        THEN ${cTier} END) AS chartTier,
      MAX(CASE WHEN TRIM(ct.name) REGEXP '^[Oo][0-9]*$' AND lc.role = 'charter'
        THEN ${oTier} END) AS oTier,
      MAX(CASE WHEN TRIM(ct.name) REGEXP '^[Vv][0-9]*$' AND lc.role = 'vfxer'
        THEN ${vTier} END) AS vfxTier
    FROM level_link_members llm
    INNER JOIN level_link_groups llg
      ON llg.id = llm.groupId
      AND (IFNULL(llg.shareChart, 0) = 1 OR IFNULL(llg.shareVfx, 0) = 1)
    INNER JOIN level_credits lc
      ON lc.levelId = llm.levelId
      AND lc.creatorId IN (:creatorIds)
      AND lc.role IN ('charter', 'vfxer')
    INNER JOIN levels l
      ON l.id = llm.levelId AND IFNULL(l.isDeleted, 0) = 0
    LEFT JOIN curations c
      ON c.levelId = llm.levelId AND IFNULL(c.isDuplicate, 0) = 0
    LEFT JOIN curation_curation_types cct ON cct.curationId = c.id
    LEFT JOIN curation_types ct ON ct.id = cct.typeId
    GROUP BY lc.creatorId, llm.groupId, llm.levelId, llg.shareChart, llg.shareVfx
    `,
    {replacements: {creatorIds: ids}, type: QueryTypes.SELECT},
  )) as ShareTierRow[];

  for (const row of rows) {
    if (row.shareChart) ctx.shareChartLevelIds.add(row.levelId);
    if (row.shareVfx) ctx.shareVfxLevelIds.add(row.levelId);
  }
  ctx.chartWinners = pickWinners(rows, 'chart');
  ctx.oWinners = pickWinners(rows, 'o');
  ctx.vfxWinners = pickWinners(rows, 'vfx');
  return ctx;
}
