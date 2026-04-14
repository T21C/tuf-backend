import { Op, QueryTypes } from 'sequelize';
import Level from '@/models/levels/Level.js';
import LevelAlias from '@/models/levels/LevelAlias.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import LevelTag from '@/models/levels/LevelTag.js';
import LevelTagAssignment from '@/models/levels/LevelTagAssignment.js';
import Creator from '@/models/credits/Creator.js';
import { CreatorAlias } from '@/models/credits/CreatorAlias.js';
import Team from '@/models/credits/Team.js';
import { TeamAlias } from '@/models/credits/TeamAlias.js';
import Curation from '@/models/curations/Curation.js';
import CurationType from '@/models/curations/CurationType.js';
import Rating from '@/models/levels/Rating.js';
import Song from '@/models/songs/Song.js';
import SongAlias from '@/models/songs/SongAlias.js';
import SongCredit from '@/models/songs/SongCredit.js';
import Artist from '@/models/artists/Artist.js';
import ArtistAlias from '@/models/artists/ArtistAlias.js';
import { logger } from '../core/LoggerService.js';

/** Reuse Team/Song rows across reindex batches (same song/team on many levels). */
const esTeamCache = new Map<number, any>();
const esSongCache = new Map<number, any>();

export function clearEsIndexRelationCaches(): void {
  esTeamCache.clear();
  esSongCache.clear();
}

function groupLevelCreditsByLevelId(rows: LevelCredit[]): Map<number, LevelCredit[]> {
  const m = new Map<number, LevelCredit[]>();
  for (const r of rows) {
    const arr = m.get(r.levelId) ?? [];
    arr.push(r);
    m.set(r.levelId, arr);
  }
  return m;
}

function groupCurationsByLevelId(rows: Curation[]): Map<number, Curation[]> {
  const m = new Map<number, Curation[]>();
  for (const c of rows) {
    const arr = m.get(c.levelId) ?? [];
    arr.push(c);
    m.set(c.levelId, arr);
  }
  return m;
}

function groupAliasesByLevelId(rows: LevelAlias[]): Map<number, LevelAlias[]> {
  const m = new Map<number, LevelAlias[]>();
  for (const r of rows) {
    const arr = m.get(r.levelId) ?? [];
    arr.push(r);
    m.set(r.levelId, arr);
  }
  return m;
}

function groupTagsByLevelId(assignments: LevelTagAssignment[]): Map<number, LevelTag[]> {
  const m = new Map<number, LevelTag[]>();
  for (const a of assignments) {
    const tag = (a as unknown as { tag?: LevelTag }).tag;
    if (!tag) continue;
    const arr = m.get(a.levelId) ?? [];
    arr.push(tag);
    m.set(a.levelId, arr);
  }
  return m;
}

export async function fetchLevelsForBulkIndex(levelIds: number[]): Promise<Level[]> {
  if (levelIds.length === 0) return [];

  const ids = [...new Set(levelIds)].map(Number).sort((a, b) => a - b);

  const levels = await Level.findAll({
    where: { id: { [Op.in]: ids } },
    order: [['id', 'ASC']],
  });

  const teamIds = [...new Set(levels.map((l) => l.teamId).filter((v): v is number => v != null))];
  const songIds = [...new Set(levels.map((l) => l.songId).filter((v): v is number => v != null))];

  const missingTeamIds = teamIds.filter((id) => !esTeamCache.has(id));
  if (missingTeamIds.length) {
    const teams = await Team.findAll({
      where: { id: { [Op.in]: missingTeamIds } },
      attributes: ['id', 'name'],
      include: [{ model: TeamAlias, as: 'teamAliases', attributes: ['name'] }],
    });
    for (const t of teams) esTeamCache.set(t.id, t.get({ plain: true }));
  }

  const missingSongIds = songIds.filter((id) => !esSongCache.has(id));
  if (missingSongIds.length) {
    const songs = await Song.findAll({
      where: { id: { [Op.in]: missingSongIds } },
      attributes: [
        'id', 
        'name', 
        'verificationState'
      ],
      include: [
        { 
          model: SongAlias, 
          as: 'aliases', 
          attributes: [
            'alias'
          ] 
        },
        {
          model: SongCredit,
          as: 'credits',
          attributes: ['role'],
          include: [
            {
              model: Artist,
              as: 'artist',
              attributes: [
                'id', 
                'name', 
                'avatarUrl', 
                'verificationState'
              ],
              include: [{ 
                model: ArtistAlias, 
                as: 'aliases', 
                attributes: [
                  'alias'
                ]}
              ],
            },
          ],
        },
      ],
    });
    for (const s of songs) esSongCache.set(s.id, s.get({ plain: true }));
  }

  const sequelize = Level.sequelize!;

  const [
    aliases,
    levelCredits,
    curations,
    ratingsRaw,
    tagAssignments,
    clearsRows,
  ] = await Promise.all([
    LevelAlias.findAll({
      where: { levelId: { [Op.in]: ids } },
      attributes: ['id', 'levelId', 'field', 'originalValue', 'alias', 'createdAt', 'updatedAt'],
    }),
    LevelCredit.findAll({
      where: { levelId: { [Op.in]: ids } },
      attributes: [
        'levelId',
        'creatorId',
        'role',
      ],
      include: [
        {
          model: Creator,
          attributes: [
            'id', 
            'name', 
            'userId', 
            'isVerified'
          ],
          as: 'creator',
          include: [{ model: CreatorAlias, as: 'creatorAliases', attributes: ['name'] }],
        },
      ],
    }),
    Curation.findAll({
      where: { levelId: { [Op.in]: ids } },
      attributes: [
        'id',
        'levelId',
        'customColor',
      ],
      include: [{ model: CurationType, as: 'types', attributes: ['id'] }],
    }),
    Rating.findAll({
      where: { levelId: { [Op.in]: ids }, confirmedAt: { [Op.ne]: null } },
      attributes: [
        'id',
        'levelId',
        'requesterFR',
        'averageDifficultyId',
        'confirmedAt',
      ],
      order: [
        ['levelId', 'ASC'],
        ['confirmedAt', 'DESC'],
      ],
    }),
    LevelTagAssignment.findAll({
      where: { levelId: { [Op.in]: ids } },
      attributes: [
        'id',
        'levelId',
        'tagId',
      ],
      include: [
        {
          model: LevelTag, 
          as: 'tag', 
          attributes: [
            'id', 
            'name', 
            'icon', 
            'color', 
            'group'
          ]
        }
      ],
    }),
    sequelize.query<{ levelId: number; cnt: string }>(
      `SELECT p.levelId, COUNT(*) AS cnt FROM passes AS p
       INNER JOIN players AS pl ON p.playerId = pl.id AND pl.isBanned = 0
       WHERE p.levelId IN (:ids) AND p.isDeleted = 0 AND p.isHidden = 0
       GROUP BY p.levelId`,
      { replacements: { ids }, type: QueryTypes.SELECT }
    ),
  ]);

  const aliasesByLevel = groupAliasesByLevelId(aliases);
  const creditsByLevel = groupLevelCreditsByLevelId(levelCredits);
  const curationsByLevel = groupCurationsByLevelId(curations);
  const tagsByLevel = groupTagsByLevelId(tagAssignments);

  const latestRatingByLevel = new Map<number, Rating>();
  for (const r of ratingsRaw) {
    if (!latestRatingByLevel.has(r.levelId)) {
      latestRatingByLevel.set(r.levelId, r);
    }
  }

  const clearsByLevel = new Map<number, number>();
  for (const row of clearsRows) {
    clearsByLevel.set(row.levelId, Number(row.cnt));
  }

  const lv = levels as unknown as Array<
    Level & { setDataValue: (k: string, v: unknown) => void }
  >;
  for (const level of lv) {
    level.setDataValue('aliases', aliasesByLevel.get(level.id) ?? []);
    level.setDataValue('levelCredits', creditsByLevel.get(level.id) ?? []);
    level.setDataValue(
      'teamObject',
      level.teamId != null ? esTeamCache.get(level.teamId) ?? undefined : undefined
    );
    level.setDataValue('curations', curationsByLevel.get(level.id) ?? []);
    const lr = latestRatingByLevel.get(level.id);
    level.setDataValue('ratings', lr ? [lr] : []);
    level.setDataValue('tags', tagsByLevel.get(level.id) ?? []);
    level.setDataValue(
      'songObject',
      level.songId != null ? esSongCache.get(level.songId) ?? undefined : undefined
    );
    level.setDataValue('clears', clearsByLevel.get(level.id) ?? 0);
  }

  return levels;
}
