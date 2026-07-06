'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('tournament_series', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      slug: {
        type: Sequelize.STRING(64),
        allowNull: false,
        unique: true,
      },
      name: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      logoUrl: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.createTable('tournaments', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      shortName: {
        type: Sequelize.STRING(128),
        allowNull: false,
      },
      fullName: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      aka: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      track: {
        type: Sequelize.ENUM('player', 'creator'),
        allowNull: false,
      },
      seriesId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'tournament_series', key: 'id' },
        onDelete: 'SET NULL',
      },
      status: {
        type: Sequelize.ENUM('draft', 'ongoing', 'completed', 'cancelled'),
        allowNull: false,
        defaultValue: 'draft',
      },
      isHidden: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      isResultsFinal: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      youtubeUrl: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      packRef: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      externalUrl: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      organizers: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      startsAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      endsAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      sortYear: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('tournaments', ['track']);
    await queryInterface.addIndex('tournaments', ['seriesId']);
    await queryInterface.addIndex('tournaments', ['status']);
    await queryInterface.addIndex('tournaments', ['isHidden']);
    await queryInterface.addIndex('tournaments', ['shortName', 'track'], {
      unique: true,
      name: 'tournaments_shortName_track_unique',
    });

    await queryInterface.createTable('tournament_tiers', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      tournamentId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'tournaments', key: 'id' },
        onDelete: 'CASCADE',
      },
      code: {
        type: Sequelize.STRING(32),
        allowNull: false,
      },
      label: {
        type: Sequelize.STRING(128),
        allowNull: false,
      },
      kind: {
        type: Sequelize.ENUM(
          'ordinal',
          'bracket',
          'round',
          'stage',
          'qualifier',
          'custom',
        ),
        allowNull: false,
        defaultValue: 'custom',
      },
      rankWeight: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 100,
      },
      isPodium: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      isShowcaseEligible: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      color: {
        type: Sequelize.STRING(32),
        allowNull: true,
      },
      iconKey: {
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      sortOrder: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('tournament_tiers', ['tournamentId']);
    await queryInterface.addIndex('tournament_tiers', ['tournamentId', 'code'], {
      unique: true,
      name: 'tournament_tiers_tournamentId_code_unique',
    });

    await queryInterface.createTable('tournament_placements', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      tournamentId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'tournaments', key: 'id' },
        onDelete: 'CASCADE',
      },
      tierId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'tournament_tiers', key: 'id' },
        onDelete: 'CASCADE',
      },
      displayName: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      playerId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'players', key: 'id' },
        onDelete: 'SET NULL',
      },
      creatorId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'creators', key: 'id' },
        onDelete: 'SET NULL',
      },
      withdrew: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      isPending: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      teamKey: {
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      teamName: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      positionInTier: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('tournament_placements', ['tournamentId']);
    await queryInterface.addIndex('tournament_placements', ['tierId']);
    await queryInterface.addIndex('tournament_placements', ['playerId']);
    await queryInterface.addIndex('tournament_placements', ['creatorId']);
    await queryInterface.addIndex('tournament_placements', ['displayName']);

    await queryInterface.createTable('placement_rewards', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      tournamentId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'tournaments', key: 'id' },
        onDelete: 'CASCADE',
      },
      seriesId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'tournament_series', key: 'id' },
        onDelete: 'CASCADE',
      },
      tierId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'tournament_tiers', key: 'id' },
        onDelete: 'CASCADE',
      },
      maxRankWeight: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      track: {
        type: Sequelize.ENUM('player', 'creator'),
        allowNull: true,
      },
      requireNotWithdrew: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      requireFinalResults: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      rewardType: {
        type: Sequelize.STRING(64),
        allowNull: false,
        defaultValue: 'avatar_frame',
      },
      assetId: {
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      assetUrl: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      config: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      label: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      priority: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('placement_rewards', ['tournamentId']);
    await queryInterface.addIndex('placement_rewards', ['seriesId']);
    await queryInterface.addIndex('placement_rewards', ['rewardType']);

    await queryInterface.createTable('placement_entitlements', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      rewardId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'placement_rewards', key: 'id' },
        onDelete: 'CASCADE',
      },
      placementId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'tournament_placements', key: 'id' },
        onDelete: 'CASCADE',
      },
      playerId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'players', key: 'id' },
        onDelete: 'CASCADE',
      },
      creatorId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'creators', key: 'id' },
        onDelete: 'CASCADE',
      },
      grantedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('placement_entitlements', ['rewardId']);
    await queryInterface.addIndex('placement_entitlements', ['placementId']);
    await queryInterface.addIndex('placement_entitlements', ['playerId']);
    await queryInterface.addIndex('placement_entitlements', ['creatorId']);
    await queryInterface.addIndex(
      'placement_entitlements',
      ['rewardId', 'placementId'],
      {
        unique: true,
        name: 'placement_entitlements_reward_placement_unique',
      },
    );

    await queryInterface.createTable('equipped_cosmetics', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      playerId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'players', key: 'id' },
        onDelete: 'CASCADE',
      },
      creatorId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'creators', key: 'id' },
        onDelete: 'CASCADE',
      },
      rewardType: {
        type: Sequelize.STRING(64),
        allowNull: false,
        defaultValue: 'avatar_frame',
      },
      entitlementId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'placement_entitlements', key: 'id' },
        onDelete: 'SET NULL',
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('equipped_cosmetics', ['playerId', 'rewardType'], {
      unique: true,
      name: 'equipped_cosmetics_player_rewardType_unique',
    });
    await queryInterface.addIndex('equipped_cosmetics', ['creatorId', 'rewardType'], {
      unique: true,
      name: 'equipped_cosmetics_creator_rewardType_unique',
    });

    await queryInterface.addColumn('players', 'featuredPlacementIds', {
      type: Sequelize.JSON,
      allowNull: true,
      defaultValue: null,
    });

    await queryInterface.addColumn('creators', 'featuredPlacementIds', {
      type: Sequelize.JSON,
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('creators', 'featuredPlacementIds');
    await queryInterface.removeColumn('players', 'featuredPlacementIds');
    await queryInterface.dropTable('equipped_cosmetics');
    await queryInterface.dropTable('placement_entitlements');
    await queryInterface.dropTable('placement_rewards');
    await queryInterface.dropTable('tournament_placements');
    await queryInterface.dropTable('tournament_tiers');
    await queryInterface.dropTable('tournaments');
    await queryInterface.dropTable('tournament_series');
  },
};
