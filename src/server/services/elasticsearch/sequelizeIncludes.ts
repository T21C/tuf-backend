import { Op, type Includeable } from 'sequelize';
import Difficulty from '@/models/levels/Difficulty.js';
import LevelAlias from '@/models/levels/LevelAlias.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import LevelTag from '@/models/levels/LevelTag.js';
import Creator from '@/models/credits/Creator.js';
import Team from '@/models/credits/Team.js';
import Player from '@/models/players/Player.js';
import Judgement from '@/models/passes/Judgement.js';
import { CreatorAlias } from '@/models/credits/CreatorAlias.js';
import { TeamAlias } from '@/models/credits/TeamAlias.js';
import User from '@/models/auth/User.js';
import Curation from '@/models/curations/Curation.js';
import CurationType from '@/models/curations/CurationType.js';
import Rating from '@/models/levels/Rating.js';
import Song from '@/models/songs/Song.js';
import SongAlias from '@/models/songs/SongAlias.js';
import SongCredit from '@/models/songs/SongCredit.js';
import Artist from '@/models/artists/Artist.js';
import ArtistAlias from '@/models/artists/ArtistAlias.js';
import Level from '@/models/levels/Level.js';
import { ownUrl } from '@/config/app.config.js';

export const LEVEL_INCLUDES: Includeable[] = [
  {
    model: Difficulty,
    as: 'difficulty',
  },
  {
    model: LevelAlias,
    as: 'aliases',
    attributes: ['alias'],
  },
  {
    model: LevelCredit,
    as: 'levelCredits',
    include: [
      {
        model: Creator,
        as: 'creator',
        include: [
          {
            model: CreatorAlias,
            as: 'creatorAliases',
            attributes: ['name'],
          },
        ],
      },
    ],
  },
  {
    model: Team,
    as: 'teamObject',
    include: [
      {
        model: TeamAlias,
        as: 'teamAliases',
        attributes: ['name'],
      },
    ],
  },
  {
    model: Curation,
    as: 'curations',
    include: [
      {
        model: CurationType,
        as: 'types',
        attributes: ['id', 'name', 'icon', 'color', 'group', 'groupSortOrder', 'sortOrder', 'abilities'],
        through: { attributes: [] },
      },
    ],
  },
  {
    model: Rating,
    as: 'ratings',
    where: {
      [Op.not]: { confirmedAt: null },
    },
    limit: 1,
    required: false,
    order: [['confirmedAt', 'DESC']] as any,
    attributes: ['id', 'levelId', 'lowDiff', 'requesterFR', 'averageDifficultyId', 'communityDifficultyId', 'confirmedAt'],
  },
  {
    model: LevelTag,
    as: 'tags',
    required: false,
    attributes: ['id', 'name', 'icon', 'color', 'group'],
    through: {
      attributes: [],
    },
  },
  {
    model: Song,
    as: 'songObject',
    required: false,
    attributes: ['id', 'name', 'verificationState'],
    include: [
      {
        model: SongAlias,
        as: 'aliases',
        attributes: ['alias'],
      },
      {
        model: SongCredit,
        as: 'credits',
        attributes: ['role'],
        include: [
          {
            model: Artist,
            as: 'artist',
            attributes: ['id', 'name', 'avatarUrl', 'verificationState'],
            include: [
              {
                model: ArtistAlias,
                as: 'aliases',
                attributes: ['alias'],
              },
            ],
          },
        ],
      },
    ],
  },
];

export const PASS_INCLUDES: Includeable[] = [
  {
    model: Player,
    as: 'player',
    attributes: ['id', 'name', 'country', 'isBanned'],
    include: [
      {
        model: User,
        as: 'user',
        attributes: ['avatarUrl', 'username'],
      },
    ],
  },
  {
    model: Level,
    as: 'level',
    include: [
      {
        model: Difficulty,
        as: 'difficulty',
      },
      {
        model: LevelCredit,
        as: 'levelCredits',
        include: [
          {
            model: Creator,
            as: 'creator',
            include: [
              {
                model: CreatorAlias,
                as: 'creatorAliases',
                attributes: ['name'],
              },
            ],
          },
        ],
      },
      {
        model: Team,
        as: 'teamObject',
        include: [
          {
            model: TeamAlias,
            as: 'teamAliases',
            attributes: ['name'],
          },
        ],
      },
      {
        model: LevelAlias,
        as: 'aliases',
        attributes: ['alias'],
      },
      {
        model: LevelTag,
        as: 'tags',
        required: false,
        attributes: ['id', 'name', 'icon', 'color', 'group'],
        through: {
          attributes: [],
        },
      },
    ],
  },
  {
    model: Judgement,
    as: 'judgements',
  },
];

export function passPlayerAvatarProxyUrl(playerId: number): string {
  const base = (ownUrl || '').replace(/\/$/, '');
  return `${base}/v2/media/player-avatar/${playerId}`;
}
