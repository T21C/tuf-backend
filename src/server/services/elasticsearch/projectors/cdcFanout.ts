import Level from '@/models/levels/Level.js';
import Pass from '@/models/passes/Pass.js';
import SongCredit from '@/models/songs/SongCredit.js';
import { Op } from 'sequelize';

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
