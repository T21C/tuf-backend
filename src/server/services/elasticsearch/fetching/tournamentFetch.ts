import {Op} from 'sequelize';
import Tournament from '@/models/tournaments/Tournament.js';
import TournamentSeries from '@/models/tournaments/TournamentSeries.js';
import TournamentPlacement from '@/models/tournaments/TournamentPlacement.js';
import TournamentPlacementCredit from '@/models/tournaments/TournamentPlacementCredit.js';
import Player from '@/models/players/Player.js';
import Creator from '@/models/credits/Creator.js';
import Level from '@/models/levels/Level.js';
import {
  buildTournamentIndexDocument,
  placementsFromIndexSource,
  type TournamentIndexInput,
} from '@/server/services/elasticsearch/indexing/tournamentIndexDocument.js';

export type PreparedTournamentDocument = {
  id: number;
  document: ReturnType<typeof buildTournamentIndexDocument>;
};

export async function fetchTournamentsForBulkIndex(
  tournamentIds: number[],
): Promise<PreparedTournamentDocument[]> {
  const ids = [...new Set(tournamentIds)].filter(id => Number.isFinite(id) && id > 0);
  if (!ids.length) return [];

  const tournaments = await Tournament.findAll({
    where: {id: {[Op.in]: ids}},
    include: [
      {model: TournamentSeries, as: 'series', required: false},
      {
        model: TournamentPlacement,
        as: 'placements',
        required: false,
        include: [
          {model: Player, as: 'player', required: false, attributes: ['id', 'name']},
          {model: Creator, as: 'creator', required: false, attributes: ['id', 'name']},
          {model: Level, as: 'level', required: false, attributes: ['id', 'song', 'artist']},
          {
            model: TournamentPlacementCredit,
            as: 'credits',
            required: false,
            include: [
              {model: Player, as: 'player', required: false, attributes: ['id', 'name']},
              {model: Creator, as: 'creator', required: false, attributes: ['id', 'name']},
            ],
          },
        ],
      },
    ],
  });

  return tournaments.map(tournament => {
    const json = tournament.toJSON() as TournamentIndexInput & {placements?: unknown};
    return {
      id: tournament.id,
      document: buildTournamentIndexDocument({
        ...json,
        placements: placementsFromIndexSource(json.placements),
      }),
    };
  });
}
