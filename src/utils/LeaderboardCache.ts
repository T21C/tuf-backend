import Player from '../models/Player';
import Pass from '../models/Pass';
import Level from '../models/Level';
import Judgement from '../models/Judgement';
import {enrichPlayerData} from './PlayerEnricher';
import {IPlayer} from '../interfaces/models';
import Difficulty from '../models/Difficulty';

interface PlayerRanks {
  rankedScoreRank: number;
  generalScoreRank: number;
  ppScoreRank: number;
  wfScoreRank: number;
  score12kRank: number;
}

class LeaderboardCache {
  private cache: Map<string, any[]>;
  private lastUpdate: Date;
  private updateInterval: number;
  private isUpdating: boolean;

  constructor() {
    this.cache = new Map();
    this.lastUpdate = new Date(0);
    this.updateInterval = 5 * 60 * 1000; // 5 minutes
    this.isUpdating = false;
  }

  public async get(
    sortBy = 'rankedScore',
    order = 'desc',
    includeAllScores = false,
  ): Promise<any[]> {
    if (this.needsUpdate()) {
      await this.updateCache();
    }

    const key = this.getCacheKey(sortBy, order, includeAllScores);

    const result = this.cache.get(key) || [];

    return result;
  }

  public async getRanks(playerId: number): Promise<PlayerRanks> {
    if (this.needsUpdate()) {
      await this.updateCache();
    }

    const ranks: PlayerRanks = {
      rankedScoreRank: 0,
      generalScoreRank: 0,
      ppScoreRank: 0,
      wfScoreRank: 0,
      score12kRank: 0,
    };

    // Get all leaderboards in descending order
    const rankedScoreLeaderboard = await this.get('rankedScore', 'desc', false);
    const generalScoreLeaderboard = await this.get(
      'generalScore',
      'desc',
      false,
    );
    const ppScoreLeaderboard = await this.get('ppScore', 'desc', false);
    const wfScoreLeaderboard = await this.get('wfScore', 'desc', false);
    const score12kLeaderboard = await this.get('score12k', 'desc', false);

    // Find player's rank in each leaderboard
    ranks.rankedScoreRank =
      rankedScoreLeaderboard.findIndex(p => p.id === playerId) + 1;
    ranks.generalScoreRank =
      generalScoreLeaderboard.findIndex(p => p.id === playerId) + 1;
    ranks.ppScoreRank =
      ppScoreLeaderboard.findIndex(p => p.id === playerId) + 1;
    ranks.wfScoreRank =
      wfScoreLeaderboard.findIndex(p => p.id === playerId) + 1;
    ranks.score12kRank =
      score12kLeaderboard.findIndex(p => p.id === playerId) + 1;

    // Convert 0 to last place + 1 for players not found in leaderboard
    const totalPlayers = rankedScoreLeaderboard.length;
    ranks.rankedScoreRank = ranks.rankedScoreRank || totalPlayers + 1;
    ranks.generalScoreRank = ranks.generalScoreRank || totalPlayers + 1;
    ranks.ppScoreRank = ranks.ppScoreRank || totalPlayers + 1;
    ranks.wfScoreRank = ranks.wfScoreRank || totalPlayers + 1;
    ranks.score12kRank = ranks.score12kRank || totalPlayers + 1;

    return ranks;
  }

  public async initialize() {
    await this.updateCache();
  }

  private async updateCache() {
    if (this.isUpdating) {
      return;
    }

    this.isUpdating = true;
    try {
      const players = await Player.findAll({
        attributes: [
          'id',
          'name',
          'country',
          'isBanned',
          'pfp',
          'createdAt',
          'updatedAt',
        ],
        include: [
          {
            model: Pass,
            as: 'passes',
            attributes: [
              'id',
              'levelId',
              'speed',
              'playerId',
              'feelingRating',
              'vidTitle',
              'vidLink',
              'vidUploadTime',
              'is12K',
              'is16K',
              'isNoHoldTap',
              'isLegacyPass',
              'isWorldsFirst',
              'accuracy',
              'scoreV2',
              'isDeleted',
            ],
            include: [
              {
                model: Level,
                as: 'level',
                attributes: ['id', 'song', 'artist', 'diffId', 'baseScore'],
                include: [
                  {
                    model: Difficulty,
                    as: 'difficulty',
                  },
                ],
              },
              {
                model: Judgement,
                as: 'judgements',
                attributes: [
                  'id',
                  'earlyDouble',
                  'earlySingle',
                  'ePerfect',
                  'perfect',
                  'lPerfect',
                  'lateSingle',
                  'lateDouble',
                ],
              },
            ],
          },
        ],
      });
      // Enrich player data with calculated fields
      const enrichedPlayers = await Promise.all(
        players.map(player => enrichPlayerData(player)),
      );

      // Cache different sorted versions
      const sortOptions = [
        'rankedScore',
        'generalScore',
        'ppScore',
        'wfScore',
        'score12k',
      ];
      const orders = ['asc', 'desc'];
      const includeScoresOptions = [true, false];

      for (const sortBy of sortOptions) {
        for (const order of orders) {
          for (const includeScores of includeScoresOptions) {
            const sortedPlayers = [...enrichedPlayers].sort((a, b) => {
              const valueA = a[sortBy as keyof IPlayer] ?? 0;
              const valueB = b[sortBy as keyof IPlayer] ?? 0;
              return order === 'asc'
                ? (valueA as number) - (valueB as number)
                : (valueB as number) - (valueA as number);
            });

            const stripPassesFromPlayer = (
              player: IPlayer,
            ): Omit<IPlayer, 'passes'> => {
              const {passes, ...playerWithoutPasses} = player;
              return playerWithoutPasses;
            };

            const finalPlayers = includeScores
              ? sortedPlayers
              : sortedPlayers.map(player => stripPassesFromPlayer(player));

            const key = this.getCacheKey(sortBy, order, includeScores);

            this.cache.set(key, finalPlayers);
          }
        }
      }

      this.lastUpdate = new Date();
    } catch (error) {
      console.error('Error updating leaderboard cache:', error);
      throw error;
    } finally {
      this.isUpdating = false;
    }
  }

  private needsUpdate(): boolean {
    return Date.now() - this.lastUpdate.getTime() > this.updateInterval;
  }

  private getCacheKey(
    sortBy: string,
    order: string,
    includeAllScores: boolean,
  ): string {
    return `${sortBy}-${order}-${includeAllScores}`;
  }
}

export default new LeaderboardCache();
