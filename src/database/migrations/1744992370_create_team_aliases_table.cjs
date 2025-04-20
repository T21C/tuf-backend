'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Create the team_aliases table
    await queryInterface.createTable('team_aliases', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      teamId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'teams',
          key: 'id',
        },
        onDelete: 'CASCADE',
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false,
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

    // 2. Add indexes
    await queryInterface.addIndex('team_aliases', ['teamId']);
    await queryInterface.addIndex('team_aliases', ['name']);
    await queryInterface.addIndex('team_aliases', ['teamId', 'name'], {
      unique: true,
    });

    // 3. Migrate existing aliases
    const teams = await queryInterface.sequelize.query(
      'SELECT id, aliases FROM teams WHERE aliases IS NOT NULL',
      { type: Sequelize.QueryTypes.SELECT }
    );

    for (const team of teams) {
      if (team.aliases) {
        const aliases = JSON.parse(team.aliases);
        if (Array.isArray(aliases) && aliases.length > 0) {
          const aliasRecords = aliases.map(alias => ({
            teamId: team.id,
            name: alias,
            createdAt: new Date(),
            updatedAt: new Date(),
          }));
          await queryInterface.bulkInsert('team_aliases', aliasRecords);
        }
      }
    }

    // 4. Drop the aliases column from teams table
    await queryInterface.removeColumn('teams', 'aliases');
  },

  async down(queryInterface, Sequelize) {
    // 1. Add back the aliases column
    await queryInterface.addColumn('teams', 'aliases', {
      type: Sequelize.JSON,
      allowNull: true,
      defaultValue: [],
    });

    // 2. Migrate data back to JSON format
    const teamAliases = await queryInterface.sequelize.query(
      'SELECT teamId, name FROM team_aliases',
      { type: Sequelize.QueryTypes.SELECT }
    );

    // Group aliases by team
    const aliasesByTeam = teamAliases.reduce((acc, { teamId, name }) => {
      if (!acc[teamId]) {
        acc[teamId] = [];
      }
      acc[teamId].push(name);
      return acc;
    }, {});

    // Update each team with their aliases
    for (const [teamId, aliases] of Object.entries(aliasesByTeam)) {
      await queryInterface.sequelize.query(
        'UPDATE teams SET aliases = ? WHERE id = ?',
        {
          replacements: [JSON.stringify(aliases), teamId],
          type: Sequelize.QueryTypes.UPDATE,
        }
      );
    }

    // 3. Drop the team_aliases table
    await queryInterface.dropTable('team_aliases');
  },
}; 