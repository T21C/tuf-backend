'use strict';

/**
 * Tournament placements redesign (Phase 1 foundation):
 * - series/tournament sortWeight + placementMode fields
 * - placement rowMode / levelId / creditedCreatorIds
 * - tournament_placement_credits table + backfill
 * - remap hidden/order prefs to credit ids; clear featured
 * - placement_entitlements.creditId
 * - drop isPodium / isShowcaseEligible
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const sequelize = queryInterface.sequelize;

    // ── Series / tournament weights & mode ──────────────────────────
    await queryInterface.addColumn('tournament_series', 'sortWeight', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });

    await queryInterface.addColumn('tournaments', 'sortWeight', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });

    await queryInterface.addColumn('tournaments', 'placementMode', {
      type: Sequelize.ENUM('profile', 'level'),
      allowNull: false,
      defaultValue: 'profile',
    });

    await queryInterface.addColumn('tournaments', 'cardLayoutDefault', {
      type: Sequelize.STRING(32),
      allowNull: true,
    });

    await queryInterface.addColumn('tournaments', 'creditRoleFilter', {
      type: Sequelize.JSON,
      allowNull: true,
    });

    // Dense backfill: series by id ASC
    const [seriesRows] = await sequelize.query(
      'SELECT id FROM tournament_series ORDER BY id ASC',
    );
    for (let i = 0; i < seriesRows.length; i++) {
      await sequelize.query(
        'UPDATE tournament_series SET sortWeight = :w WHERE id = :id',
        {replacements: {w: i + 1, id: seriesRows[i].id}},
      );
    }

    // Dense backfill: tournaments within each seriesId (null bucket together)
    const [tournamentRows] = await sequelize.query(
      `SELECT id, seriesId FROM tournaments
       ORDER BY (seriesId IS NULL), seriesId ASC, id ASC`,
    );
    const bucketCounters = new Map();
    for (const row of tournamentRows) {
      const key = row.seriesId == null ? '__null__' : String(row.seriesId);
      const next = (bucketCounters.get(key) ?? 0) + 1;
      bucketCounters.set(key, next);
      await sequelize.query(
        'UPDATE tournaments SET sortWeight = :w WHERE id = :id',
        {replacements: {w: next, id: row.id}},
      );
    }

    // ── Placement columns ───────────────────────────────────────────
    await queryInterface.addColumn('tournament_placements', 'rowMode', {
      type: Sequelize.ENUM('profile', 'level'),
      allowNull: true,
    });

    await queryInterface.addColumn('tournament_placements', 'levelId', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });

    await queryInterface.addColumn('tournament_placements', 'creditedCreatorIds', {
      type: Sequelize.JSON,
      allowNull: true,
    });

    await queryInterface.addIndex('tournament_placements', ['levelId'], {
      name: 'tournament_placements_levelId',
    });

    // ── Credits table ───────────────────────────────────────────────
    await queryInterface.createTable('tournament_placement_credits', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      placementId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {model: 'tournament_placements', key: 'id'},
        onDelete: 'CASCADE',
      },
      playerId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {model: 'players', key: 'id'},
        onDelete: 'SET NULL',
      },
      creatorId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {model: 'creators', key: 'id'},
        onDelete: 'SET NULL',
      },
      isGuest: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
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

    await queryInterface.addIndex('tournament_placement_credits', ['placementId']);
    await queryInterface.addIndex('tournament_placement_credits', ['playerId']);
    await queryInterface.addIndex('tournament_placement_credits', ['creatorId']);
    await queryInterface.addIndex(
      'tournament_placement_credits',
      ['placementId', 'creatorId'],
      {
        unique: true,
        name: 'tpc_placement_creator_unique',
      },
    );
    await queryInterface.addIndex(
      'tournament_placement_credits',
      ['placementId', 'playerId'],
      {
        unique: true,
        name: 'tpc_placement_player_unique',
      },
    );

    // Backfill one credit per linked placement
    await sequelize.query(`
      INSERT INTO tournament_placement_credits
        (placementId, playerId, creatorId, isGuest, sortOrder, createdAt, updatedAt)
      SELECT
        p.id,
        p.playerId,
        p.creatorId,
        0,
        0,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      FROM tournament_placements p
      WHERE p.playerId IS NOT NULL OR p.creatorId IS NOT NULL
    `);

    // Remap player/creator prefs: placement id → credit id; clear featured
    const [creditMapRows] = await sequelize.query(`
      SELECT placementId, id AS creditId
      FROM tournament_placement_credits
    `);
    const placementToCredit = new Map(
      creditMapRows.map(r => [Number(r.placementId), Number(r.creditId)]),
    );

    async function remapSubjectPrefs(table) {
      const [rows] = await sequelize.query(
        `SELECT id, featuredPlacementIds, hiddenPlacementIds, placementOrderIds FROM ${table}`,
      );
      for (const row of rows) {
        const remapList = value => {
          if (!Array.isArray(value)) return null;
          const mapped = [
            ...new Set(
              value
                .map(Number)
                .filter(n => Number.isFinite(n))
                .map(id => placementToCredit.get(id))
                .filter(id => id != null),
            ),
          ];
          return mapped.length ? JSON.stringify(mapped) : null;
        };

        const hidden = remapList(
          typeof row.hiddenPlacementIds === 'string'
            ? JSON.parse(row.hiddenPlacementIds)
            : row.hiddenPlacementIds,
        );
        const order = remapList(
          typeof row.placementOrderIds === 'string'
            ? JSON.parse(row.placementOrderIds)
            : row.placementOrderIds,
        );

        await sequelize.query(
          `UPDATE ${table}
           SET featuredPlacementIds = NULL,
               hiddenPlacementIds = :hidden,
               placementOrderIds = :order
           WHERE id = :id`,
          {
            replacements: {
              id: row.id,
              hidden,
              order,
            },
          },
        );
      }
    }

    await remapSubjectPrefs('players');
    await remapSubjectPrefs('creators');

    // ── Entitlements: creditId ──────────────────────────────────────
    await queryInterface.addColumn('placement_entitlements', 'creditId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {model: 'tournament_placement_credits', key: 'id'},
      onDelete: 'CASCADE',
    });

    await sequelize.query(`
      UPDATE placement_entitlements e
      INNER JOIN tournament_placement_credits c
        ON c.placementId = e.placementId
        AND (
          (e.playerId IS NOT NULL AND c.playerId = e.playerId)
          OR (e.creatorId IS NOT NULL AND c.creatorId = e.creatorId)
        )
      SET e.creditId = c.id
    `);

    await queryInterface.removeIndex(
      'placement_entitlements',
      'placement_entitlements_reward_placement_unique',
    );
    await queryInterface.addIndex(
      'placement_entitlements',
      ['rewardId', 'creditId'],
      {
        unique: true,
        name: 'placement_entitlements_reward_credit_unique',
      },
    );
    await queryInterface.addIndex('placement_entitlements', ['creditId'], {
      name: 'placement_entitlements_creditId',
    });

    // ── Drop podium / showcase ──────────────────────────────────────
    await queryInterface.removeColumn('tournament_tiers', 'isPodium');
    await queryInterface.removeColumn('tournament_tiers', 'isShowcaseEligible');
  },

  async down(queryInterface, Sequelize) {
    const sequelize = queryInterface.sequelize;

    await queryInterface.addColumn('tournament_tiers', 'isPodium', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn('tournament_tiers', 'isShowcaseEligible', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });

    await queryInterface.removeIndex(
      'placement_entitlements',
      'placement_entitlements_reward_credit_unique',
    );
    await queryInterface.removeIndex(
      'placement_entitlements',
      'placement_entitlements_creditId',
    );
    await queryInterface.addIndex(
      'placement_entitlements',
      ['rewardId', 'placementId'],
      {
        unique: true,
        name: 'placement_entitlements_reward_placement_unique',
      },
    );
    await queryInterface.removeColumn('placement_entitlements', 'creditId');

    await queryInterface.dropTable('tournament_placement_credits');

    await queryInterface.removeIndex(
      'tournament_placements',
      'tournament_placements_levelId',
    );
    await queryInterface.removeColumn('tournament_placements', 'creditedCreatorIds');
    await queryInterface.removeColumn('tournament_placements', 'levelId');
    await queryInterface.removeColumn('tournament_placements', 'rowMode');

    await queryInterface.removeColumn('tournaments', 'creditRoleFilter');
    await queryInterface.removeColumn('tournaments', 'cardLayoutDefault');
    await queryInterface.removeColumn('tournaments', 'placementMode');
    await queryInterface.removeColumn('tournaments', 'sortWeight');
    await queryInterface.removeColumn('tournament_series', 'sortWeight');

    // MySQL may leave ENUM types; attempt cleanup of placementMode/rowMode enums
    try {
      await sequelize.query('DROP TYPE IF EXISTS enum_tournaments_placementMode');
    } catch {
      /* ignore */
    }
  },
};
