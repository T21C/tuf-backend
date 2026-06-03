'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface */
/** @param {import('sequelize').Sequelize} Sequelize */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('level_announcement_queue', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      levelId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'levels', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      kind: {
        type: Sequelize.ENUM('NEW', 'RERATE'),
        allowNull: false,
      },
      facets: {
        type: Sequelize.JSON,
        allowNull: false,
        defaultValue: '[]',
      },
      before: {
        type: Sequelize.JSON,
        allowNull: false,
        defaultValue: '{}',
      },
      after: {
        type: Sequelize.JSON,
        allowNull: false,
        defaultValue: '{}',
      },
      status: {
        type: Sequelize.ENUM('PENDING', 'ANNOUNCED', 'SKIPPED'),
        allowNull: false,
        defaultValue: 'PENDING',
      },
      pendingUniqueKey: {
        type: Sequelize.INTEGER,
        allowNull: true,
        comment: 'Set to levelId while PENDING; NULL otherwise (MySQL partial-unique surrogate)',
      },
      enqueuedBy: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      announcedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('level_announcement_queue', ['levelId'], {
      name: 'idx_level_announcement_queue_level_id',
    });
    await queryInterface.addIndex('level_announcement_queue', ['status'], {
      name: 'idx_level_announcement_queue_status',
    });
    await queryInterface.addIndex('level_announcement_queue', ['kind', 'status'], {
      name: 'idx_level_announcement_queue_kind_status',
    });
    await queryInterface.addConstraint('level_announcement_queue', {
      fields: ['pendingUniqueKey'],
      type: 'unique',
      name: 'uniq_level_announcement_queue_pending_level',
    });

    // Backfill existing unannounced new levels
    await queryInterface.sequelize.query(`
      INSERT INTO level_announcement_queue (
        levelId, kind, facets, \`before\`, \`after\`, status, pendingUniqueKey, createdAt, updatedAt
      )
      SELECT
        l.id,
        'NEW',
        JSON_ARRAY('DIFF'),
        JSON_OBJECT(
          'diffId', COALESCE(l.previousDiffId, 0),
          'baseScore', l.previousBaseScore,
          'ppBaseScore', l.ppBaseScore
        ),
        JSON_OBJECT(
          'diffId', l.diffId,
          'baseScore', l.baseScore,
          'ppBaseScore', l.ppBaseScore,
          'curve', CASE
            WHEN l.xaccCurveMeta IS NOT NULL AND JSON_TYPE(l.xaccCurveMeta) = 'OBJECT' THEN
              JSON_OBJECT(
                'poleOffset', COALESCE(
                  CAST(JSON_UNQUOTE(JSON_EXTRACT(l.xaccCurveMeta, '$.poleOffset')) AS DECIMAL(20,10)),
                  0.0054017154
                ),
                'topMultiplier', COALESCE(
                  CAST(JSON_UNQUOTE(JSON_EXTRACT(l.xaccCurveMeta, '$.topMultiplier')) AS DECIMAL(20,10)),
                  5.51289781
                )
              )
            ELSE NULL
          END
        ),
        'PENDING',
        l.id,
        NOW(),
        NOW()
      FROM levels l
      WHERE l.isAnnounced = 0
        AND l.isDeleted = 0
        AND l.diffId <> 0
        AND (l.previousDiffId IS NULL OR l.previousDiffId = 0)
    `);

    // Backfill existing unannounced rerates
    await queryInterface.sequelize.query(`
      INSERT INTO level_announcement_queue (
        levelId, kind, facets, \`before\`, \`after\`, status, pendingUniqueKey, createdAt, updatedAt
      )
      SELECT
        l.id,
        'RERATE',
        CASE
          WHEN l.previousDiffId <> l.diffId
            AND COALESCE(l.previousBaseScore, 0) <> COALESCE(l.baseScore, 0)
            THEN JSON_ARRAY('DIFF', 'BASE_SCORE')
          WHEN l.previousDiffId <> l.diffId THEN JSON_ARRAY('DIFF')
          WHEN COALESCE(l.previousBaseScore, 0) <> COALESCE(l.baseScore, 0) THEN JSON_ARRAY('BASE_SCORE')
          ELSE JSON_ARRAY('DIFF')
        END,
        JSON_OBJECT(
          'diffId', COALESCE(l.previousDiffId, l.diffId),
          'baseScore', COALESCE(l.previousBaseScore, l.baseScore),
          'ppBaseScore', l.ppBaseScore,
          'curve', CASE
            WHEN l.xaccCurveMeta IS NOT NULL AND JSON_TYPE(l.xaccCurveMeta) = 'OBJECT' THEN
              JSON_OBJECT(
                'poleOffset', COALESCE(
                  CAST(JSON_UNQUOTE(JSON_EXTRACT(l.xaccCurveMeta, '$.poleOffset')) AS DECIMAL(20,10)),
                  0.0054017154
                ),
                'topMultiplier', COALESCE(
                  CAST(JSON_UNQUOTE(JSON_EXTRACT(l.xaccCurveMeta, '$.topMultiplier')) AS DECIMAL(20,10)),
                  5.51289781
                )
              )
            ELSE NULL
          END
        ),
        JSON_OBJECT(
          'diffId', l.diffId,
          'baseScore', l.baseScore,
          'ppBaseScore', l.ppBaseScore,
          'curve', CASE
            WHEN l.xaccCurveMeta IS NOT NULL AND JSON_TYPE(l.xaccCurveMeta) = 'OBJECT' THEN
              JSON_OBJECT(
                'poleOffset', COALESCE(
                  CAST(JSON_UNQUOTE(JSON_EXTRACT(l.xaccCurveMeta, '$.poleOffset')) AS DECIMAL(20,10)),
                  0.0054017154
                ),
                'topMultiplier', COALESCE(
                  CAST(JSON_UNQUOTE(JSON_EXTRACT(l.xaccCurveMeta, '$.topMultiplier')) AS DECIMAL(20,10)),
                  5.51289781
                )
              )
            ELSE NULL
          END
        ),
        'PENDING',
        l.id,
        NOW(),
        NOW()
      FROM levels l
      WHERE l.isAnnounced = 0
        AND l.isDeleted = 0
        AND l.diffId <> 0
        AND l.previousDiffId IS NOT NULL
        AND l.previousDiffId <> 0
    `);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('level_announcement_queue');
  },
};
