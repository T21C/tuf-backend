import Level from '@/models/levels/Level.js';
import Pass from '@/models/passes/Pass.js';
import SongCredit from '@/models/songs/SongCredit.js';
import Tournament from '@/models/tournaments/Tournament.js';
import TournamentPlacement from '@/models/tournaments/TournamentPlacement.js';
import TournamentPlacementCredit from '@/models/tournaments/TournamentPlacementCredit.js';
import { Op } from 'sequelize';

function uniquePositiveIds(ids: Array<number | null | undefined>): number[] {
  return [...new Set(ids.filter((id): id is number => typeof id === 'number' && Number.isFinite(id) && id > 0))];
}

export async function getLevelIdsBySongId(songId: number): Promise<number[]> {
  const levels = await Level.findAll({
    where: { songId, isDeleted: false },
    attributes: ['id'],
    raw: true,
  });
  return (levels as { id: number }[]).map((l) => l.id);
}

export async function getLevelIdsByArtistId(artistId: number): Promise<number[]> {
  const songCredits = await SongCredit.findAll({
    where: { artistId },
    attributes: ['songId'],
    group: ['songId'],
    raw: true,
  });
  const songIds = [...new Set((songCredits as { songId: number }[]).map((c) => c.songId))];
  if (songIds.length === 0) return [];
  const levels = await Level.findAll({
    where: { songId: { [Op.in]: songIds }, isDeleted: false },
    attributes: ['id'],
    raw: true,
  });
  return (levels as { id: number }[]).map((l) => l.id);
}

export async function getLevelIdsByPlayerId(playerId: number): Promise<number[]> {
  const rows = await Pass.findAll({
    where: { playerId, isDeleted: false },
    attributes: ['levelId'],
    group: ['levelId'],
    raw: true,
  });
  return [...new Set((rows as { levelId: number }[]).map((r) => r.levelId))].filter(
    (id) => typeof id === 'number' && Number.isFinite(id) && id > 0,
  );
}

export async function getPassIdsByLevelId(levelId: number): Promise<number[]> {
  const rows = await Pass.findAll({
    where: { levelId },
    attributes: ['id'],
    raw: true,
  });
  return (rows as { id: number }[])
    .map((r) => r.id)
    .filter((id) => typeof id === 'number' && Number.isFinite(id) && id > 0);
}

export async function getTournamentIdsBySeriesId(seriesId: number): Promise<number[]> {
  const rows = await Tournament.findAll({
    where: { seriesId },
    attributes: ['id'],
    raw: true,
  });
  return uniquePositiveIds((rows as { id: number }[]).map((r) => r.id));
}

export async function getTournamentIdsByLevelId(levelId: number): Promise<number[]> {
  const rows = await TournamentPlacement.findAll({
    where: { levelId },
    attributes: ['tournamentId'],
    raw: true,
  });
  return uniquePositiveIds((rows as { tournamentId: number }[]).map((r) => r.tournamentId));
}

export async function getTournamentIdsByPlayerId(playerId: number): Promise<number[]> {
  const [placementRows, creditRows] = await Promise.all([
    TournamentPlacement.findAll({
      where: { playerId },
      attributes: ['tournamentId'],
      raw: true,
    }),
    TournamentPlacementCredit.findAll({
      where: { playerId },
      attributes: ['placementId'],
      include: [
        {
          model: TournamentPlacement,
          as: 'placement',
          required: true,
          attributes: ['tournamentId'],
        },
      ],
    }),
  ]);
  const fromCredits = creditRows.map(
    (row) => Number((row as TournamentPlacementCredit & {placement?: {tournamentId?: number}}).placement?.tournamentId),
  );
  return uniquePositiveIds([
    ...(placementRows as { tournamentId: number }[]).map((r) => r.tournamentId),
    ...fromCredits,
  ]);
}

export async function getTournamentIdsByCreatorId(creatorId: number): Promise<number[]> {
  const [placementRows, creditRows] = await Promise.all([
    TournamentPlacement.findAll({
      where: { creatorId },
      attributes: ['tournamentId'],
      raw: true,
    }),
    TournamentPlacementCredit.findAll({
      where: { creatorId },
      attributes: ['placementId'],
      include: [
        {
          model: TournamentPlacement,
          as: 'placement',
          required: true,
          attributes: ['tournamentId'],
        },
      ],
    }),
  ]);
  const fromCredits = creditRows.map(
    (row) => Number((row as TournamentPlacementCredit & {placement?: {tournamentId?: number}}).placement?.tournamentId),
  );
  return uniquePositiveIds([
    ...(placementRows as { tournamentId: number }[]).map((r) => r.tournamentId),
    ...fromCredits,
  ]);
}

export async function getTournamentIdByPlacementId(placementId: number): Promise<number | null> {
  const placement = await TournamentPlacement.findByPk(placementId, {
    attributes: ['tournamentId'],
  });
  const id = Number(placement?.tournamentId);
  return Number.isFinite(id) && id > 0 ? id : null;
}
