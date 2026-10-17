'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'level_submissions',
        'levelId',
        {
          type: Sequelize.INTEGER,
          allowNull: true,
          defaultValue: null,
        },
        {transaction},
      );
      await queryInterface.addIndex('level_submissions', ['levelId'], {
        unique: true,
        name: 'level_submissions_levelId_unique',
        transaction,
      });
      await queryInterface.addConstraint('level_submissions', {
        fields: ['levelId'],
        type: 'foreign key',
        name: 'level_submissions_levelId_levels_fk',
        references: {table: 'levels', field: 'id'},
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        transaction,
      });

      await queryInterface.addColumn(
        'pass_submissions',
        'passId',
        {
          type: Sequelize.INTEGER,
          allowNull: true,
          defaultValue: null,
        },
        {transaction},
      );
      await queryInterface.addIndex('pass_submissions', ['passId'], {
        unique: true,
        name: 'pass_submissions_passId_unique',
        transaction,
      });
      await queryInterface.addConstraint('pass_submissions', {
        fields: ['passId'],
        type: 'foreign key',
        name: 'pass_submissions_passId_passes_fk',
        references: {table: 'passes', field: 'id'},
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        transaction,
      });

      await backfillCreatedEntities(queryInterface, transaction);

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.removeConstraint(
        'level_submissions',
        'level_submissions_levelId_levels_fk',
        {transaction},
      );
      await queryInterface.removeIndex(
        'level_submissions',
        'level_submissions_levelId_unique',
        {transaction},
      );
      await queryInterface.removeColumn('level_submissions', 'levelId', {transaction});

      await queryInterface.removeConstraint(
        'pass_submissions',
        'pass_submissions_passId_passes_fk',
        {transaction},
      );
      await queryInterface.removeIndex(
        'pass_submissions',
        'pass_submissions_passId_unique',
        {transaction},
      );
      await queryInterface.removeColumn('pass_submissions', 'passId', {transaction});

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};

const YOUTUBE_ID_SQL = `
  CASE
    WHEN extracted REGEXP '^[A-Za-z0-9_-]{11}$' THEN extracted
    ELSE NULL
  END
`;

function youtubeIdSql(column) {
  const extracted = `
    CASE
      WHEN ${column} LIKE '%youtu.be/%' THEN
        LEFT(SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(${column}, 'youtu.be/', -1), '?', 1), '/', 1), 11)
      WHEN ${column} LIKE '%watch?v=%' THEN
        LEFT(SUBSTRING_INDEX(SUBSTRING_INDEX(${column}, 'watch?v=', -1), '&', 1), 11)
      WHEN ${column} LIKE '%/shorts/%' THEN
        LEFT(SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(${column}, '/shorts/', -1), '?', 1), '/', 1), 11)
      WHEN ${column} LIKE '%/embed/%' THEN
        LEFT(SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(${column}, '/embed/', -1), '?', 1), '/', 1), 11)
      WHEN ${column} LIKE '%/live/%' THEN
        LEFT(SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(${column}, '/live/', -1), '?', 1), '/', 1), 11)
      ELSE NULL
    END
  `;
  return YOUTUBE_ID_SQL.replace(/extracted/g, `(${extracted})`);
}

function bilibiliIdSql(column) {
  return `REGEXP_SUBSTR(${column}, 'BV[0-9A-Za-z]{10}')`;
}

const CHART_TITLE_SQL = `
  (
    l.song = s.song
    OR (
      s.suffix IS NOT NULL AND s.suffix <> ''
      AND l.song = CONCAT(s.song, ' ', s.suffix)
    )
    OR (
      s.songId IS NOT NULL
      AND l.songId = s.songId
      AND s.suffix <=> l.suffix
    )
  )
`;

async function keepExclusivePairs(queryInterface, transaction, table, leftCol, rightCol) {
  const bad = `${table}_bad`;
  await queryInterface.sequelize.query(
    `CREATE TEMPORARY TABLE ${bad} (pairKey INT NOT NULL PRIMARY KEY)`,
    {transaction},
  );
  await queryInterface.sequelize.query(
    `
    INSERT INTO ${bad} (pairKey)
    SELECT ${leftCol} FROM ${table} GROUP BY ${leftCol} HAVING COUNT(*) <> 1
    `,
    {transaction},
  );
  await queryInterface.sequelize.query(
    `DELETE m FROM ${table} m INNER JOIN ${bad} bad ON bad.pairKey = m.${leftCol}`,
    {transaction},
  );
  await queryInterface.sequelize.query(`DELETE FROM ${bad}`, {transaction});
  await queryInterface.sequelize.query(
    `
    INSERT INTO ${bad} (pairKey)
    SELECT ${rightCol} FROM ${table} GROUP BY ${rightCol} HAVING COUNT(*) <> 1
    `,
    {transaction},
  );
  await queryInterface.sequelize.query(
    `DELETE m FROM ${table} m INNER JOIN ${bad} bad ON bad.pairKey = m.${rightCol}`,
    {transaction},
  );
  await queryInterface.sequelize.query(`DROP TEMPORARY TABLE ${bad}`, {transaction});
}

async function assignChartPairs(queryInterface, transaction) {
  await queryInterface.sequelize.query(
    `
    DELETE m FROM chart_created_match m
    INNER JOIN level_submissions s ON s.levelId = m.levelId
    `,
    {transaction},
  );
  await keepExclusivePairs(
    queryInterface,
    transaction,
    'chart_created_match',
    'submissionId',
    'levelId',
  );
  await queryInterface.sequelize.query(
    `
    UPDATE level_submissions s
    INNER JOIN chart_created_match m ON m.submissionId = s.id
    SET s.levelId = m.levelId
    WHERE s.status = 'approved' AND s.levelId IS NULL
    `,
    {transaction},
  );
  await queryInterface.sequelize.query('DELETE FROM chart_created_match', {transaction});
}

async function assignPassPairs(queryInterface, transaction) {
  await queryInterface.sequelize.query(
    `
    DELETE m FROM pass_created_match m
    INNER JOIN pass_submissions s ON s.passId = m.passId
    `,
    {transaction},
  );
  await keepExclusivePairs(
    queryInterface,
    transaction,
    'pass_created_match',
    'submissionId',
    'passId',
  );
  await queryInterface.sequelize.query(
    `
    UPDATE pass_submissions s
    INNER JOIN pass_created_match m ON m.submissionId = s.id
    SET s.passId = m.passId
    WHERE s.status = 'approved' AND s.passId IS NULL
    `,
    {transaction},
  );
  await queryInterface.sequelize.query('DELETE FROM pass_created_match', {transaction});
}

async function backfillCreatedEntities(queryInterface, transaction) {
  await queryInterface.sequelize.query(
    `
    CREATE TEMPORARY TABLE chart_created_match (
      submissionId INT NOT NULL,
      levelId INT NOT NULL,
      PRIMARY KEY (submissionId, levelId)
    )
    `,
    {transaction},
  );
  await queryInterface.sequelize.query(
    `
    CREATE TEMPORARY TABLE pass_created_match (
      submissionId INT NOT NULL,
      passId INT NOT NULL,
      PRIMARY KEY (submissionId, passId)
    )
    `,
    {transaction},
  );

  const submissionYt = youtubeIdSql('s.videoLink');
  const submissionBv = bilibiliIdSql('s.videoLink');
  const passYt = youtubeIdSql('p.videoLink');
  const passBv = bilibiliIdSql('p.videoLink');

  await queryInterface.sequelize.query(
    `
    INSERT IGNORE INTO chart_created_match (submissionId, levelId)
    SELECT s.id, l.id
    FROM level_submissions s
    INNER JOIN notifications n
      ON n.type = 'chart.submission.approved'
     AND n.dedupKey = CONCAT('chart-submission:', s.id, ':approved')
    INNER JOIN levels l
      ON l.id = CAST(JSON_UNQUOTE(JSON_EXTRACT(n.payload, '$.levelId')) AS UNSIGNED)
     AND l.isDeleted = 0
    WHERE s.status = 'approved' AND s.levelId IS NULL
    `,
    {transaction},
  );
  await assignChartPairs(queryInterface, transaction);

  await queryInterface.sequelize.query(
    `
    INSERT IGNORE INTO chart_created_match (submissionId, levelId)
    SELECT s.id, l.id
    FROM level_submissions s
    INNER JOIN levels l
      ON l.isDeleted = 0
     AND (l.dlLink = s.directDL OR l.legacyDllink = s.directDL)
    WHERE s.status = 'approved'
      AND s.levelId IS NULL
      AND s.directDL LIKE 'http%'
    `,
    {transaction},
  );
  await assignChartPairs(queryInterface, transaction);

  await queryInterface.sequelize.query(
    `
    INSERT IGNORE INTO chart_created_match (submissionId, levelId)
    SELECT s.id, l.id
    FROM level_submissions s
    INNER JOIN levels l ON l.isDeleted = 0 AND ${CHART_TITLE_SQL}
    WHERE s.status = 'approved'
      AND s.levelId IS NULL
      AND (
        (${submissionYt}) IS NOT NULL AND l.videoLink LIKE CONCAT('%', (${submissionYt}), '%')
        OR (${submissionBv}) IS NOT NULL AND l.videoLink LIKE CONCAT('%', (${submissionBv}), '%')
      )
    `,
    {transaction},
  );
  await assignChartPairs(queryInterface, transaction);

  await queryInterface.sequelize.query(
    `
    INSERT IGNORE INTO chart_created_match (submissionId, levelId)
    SELECT s.id, l.id
    FROM level_submissions s
    INNER JOIN levels l ON l.isDeleted = 0 AND ${CHART_TITLE_SQL}
    WHERE s.status = 'approved' AND s.levelId IS NULL
    `,
    {transaction},
  );
  await assignChartPairs(queryInterface, transaction);

  await queryInterface.sequelize.query(
    `
    INSERT IGNORE INTO pass_created_match (submissionId, passId)
    SELECT s.id, p.id
    FROM pass_submissions s
    INNER JOIN notifications n
      ON n.type = 'pass.submission.approved'
     AND n.dedupKey = CONCAT('pass-submission:', s.id, ':approved')
    INNER JOIN passes p
      ON p.id = CAST(JSON_UNQUOTE(JSON_EXTRACT(n.payload, '$.passId')) AS UNSIGNED)
     AND (p.isDeleted = 0 OR p.isDeleted IS NULL)
    WHERE s.status = 'approved' AND s.passId IS NULL
    `,
    {transaction},
  );
  await assignPassPairs(queryInterface, transaction);

  await queryInterface.sequelize.query(
    `
    INSERT IGNORE INTO pass_created_match (submissionId, passId)
    SELECT s.id, p.id
    FROM pass_submissions s
    INNER JOIN passes p
      ON p.levelId = s.levelId
     AND p.playerId = s.assignedPlayerId
     AND (p.isDeleted = 0 OR p.isDeleted IS NULL)
     AND s.scoreV2 IS NOT NULL
     AND p.scoreV2 IS NOT NULL
     AND ABS(p.scoreV2 - s.scoreV2) < 0.05
     AND (
       ((${submissionYt}) IS NOT NULL AND (${passYt}) = (${submissionYt}))
       OR ((${submissionBv}) IS NOT NULL AND (${passBv}) = (${submissionBv}))
       OR (
         (${submissionYt}) IS NULL
         AND (${submissionBv}) IS NULL
         AND TRIM(s.videoLink) <> ''
         AND TRIM(p.videoLink) = TRIM(s.videoLink)
       )
     )
    WHERE s.status = 'approved'
      AND s.passId IS NULL
      AND s.assignedPlayerId IS NOT NULL
    `,
    {transaction},
  );
  await assignPassPairs(queryInterface, transaction);

  await queryInterface.sequelize.query('DROP TEMPORARY TABLE chart_created_match', {transaction});
  await queryInterface.sequelize.query('DROP TEMPORARY TABLE pass_created_match', {transaction});
}
