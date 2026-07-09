'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    const [duplicateGroups] = await sequelize.query(`
      SELECT shortName
      FROM tournaments
      GROUP BY shortName
      HAVING COUNT(*) > 1
    `);

    for (const group of duplicateGroups) {
      const [rows] = await sequelize.query(
        `SELECT id, shortName, track
         FROM tournaments
         WHERE shortName = :shortName
         ORDER BY id ASC`,
        {replacements: {shortName: group.shortName}},
      );

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const suffix = ` (${row.track})`;
        const base = String(row.shortName);
        const maxBaseLen = 128 - suffix.length;
        const nextName = `${base.slice(0, maxBaseLen)}${suffix}`;
        await sequelize.query(
          'UPDATE tournaments SET shortName = :nextName WHERE id = :id',
          {replacements: {nextName, id: row.id}},
        );
      }
    }

    await queryInterface.removeIndex('tournaments', 'tournaments_shortName_track_unique');
    await queryInterface.addIndex('tournaments', ['shortName'], {
      unique: true,
      name: 'tournaments_shortName_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('tournaments', 'tournaments_shortName_unique');
    await queryInterface.addIndex('tournaments', ['shortName', 'track'], {
      unique: true,
      name: 'tournaments_shortName_track_unique',
    });
  },
};
