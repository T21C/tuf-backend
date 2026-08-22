import {QueryTypes} from 'sequelize';
import sequelize from '@/config/db.js';

/** C-family names: `C` or `C` + digits. */
export const SQL_C_FAMILY_NAME = `TRIM(ct.name) REGEXP '^[Cc][0-9]*$'`;
/** O-family names: `O` or `O` + digits. Grouped by chartSubgroup (same pool as C). */
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
  const subCol = family === 'V' ? 'vfxSubgroup' : 'chartSubgroup';
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
      SELECT 1 FROM level_link_members llm_self
      INNER JOIN level_link_members llm_sib
        ON llm_sib.groupId = llm_self.groupId
        AND llm_sib.levelId <> llm_self.levelId
        AND llm_sib.${subCol} = llm_self.${subCol}
      WHERE llm_self.levelId = c.levelId
        AND llm_self.${subCol} IS NOT NULL
    )
    OR NOT EXISTS (
      SELECT 1
      FROM level_link_members llm_self
      INNER JOIN level_link_members llm_other
        ON llm_other.groupId = llm_self.groupId
        AND llm_other.levelId <> c.levelId
        AND llm_other.${subCol} = llm_self.${subCol}
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
        AND llm_self.${subCol} IS NOT NULL
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
 * of a chartSubgroup (C and O) / vfxSubgroup (V) pool for this creator.
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
  chartSubgroup: number | null;
  vfxSubgroup: number | null;
  chartSubgroupSize: number;
  vfxSubgroupSize: number;
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
    const subgroup = family === 'vfx' ? row.vfxSubgroup : row.chartSubgroup;
    const size = family === 'vfx' ? row.vfxSubgroupSize : row.chartSubgroupSize;
    const tier =
      family === 'chart' ? row.chartTier : family === 'o' ? row.oTier : row.vfxTier;
    if (subgroup == null || Number(size) < 2 || tier == null || !Number.isFinite(Number(tier))) {
      continue;
    }
    const key = `${row.creatorId}:${row.groupId}:${subgroup}`;
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
      llm.chartSubgroup AS chartSubgroup,
      llm.vfxSubgroup AS vfxSubgroup,
      (
        SELECT COUNT(*) FROM level_link_members sib
        WHERE sib.groupId = llm.groupId
          AND sib.chartSubgroup IS NOT NULL
          AND sib.chartSubgroup = llm.chartSubgroup
      ) AS chartSubgroupSize,
      (
        SELECT COUNT(*) FROM level_link_members sib
        WHERE sib.groupId = llm.groupId
          AND sib.vfxSubgroup IS NOT NULL
          AND sib.vfxSubgroup = llm.vfxSubgroup
      ) AS vfxSubgroupSize,
      MAX(CASE WHEN TRIM(ct.name) REGEXP '^[Cc][0-9]*$' AND lc.role = 'charter'
        THEN ${cTier} END) AS chartTier,
      MAX(CASE WHEN TRIM(ct.name) REGEXP '^[Oo][0-9]*$' AND lc.role = 'charter'
        THEN ${oTier} END) AS oTier,
      MAX(CASE WHEN TRIM(ct.name) REGEXP '^[Vv][0-9]*$' AND lc.role = 'vfxer'
        THEN ${vTier} END) AS vfxTier
    FROM level_link_members llm
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
    WHERE llm.chartSubgroup IS NOT NULL OR llm.vfxSubgroup IS NOT NULL
    GROUP BY
      lc.creatorId, llm.groupId, llm.levelId,
      llm.chartSubgroup, llm.vfxSubgroup
    `,
    {replacements: {creatorIds: ids}, type: QueryTypes.SELECT},
  )) as ShareTierRow[];

  for (const row of rows) {
    if (row.chartSubgroup != null && Number(row.chartSubgroupSize) >= 2) {
      ctx.shareChartLevelIds.add(row.levelId);
    }
    if (row.vfxSubgroup != null && Number(row.vfxSubgroupSize) >= 2) {
      ctx.shareVfxLevelIds.add(row.levelId);
    }
  }
  ctx.chartWinners = pickWinners(rows, 'chart');
  ctx.oWinners = pickWinners(rows, 'o');
  ctx.vfxWinners = pickWinners(rows, 'vfx');
  return ctx;
}
