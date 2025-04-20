'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Create the creator_aliases table
    await queryInterface.createTable('creator_aliases', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      creatorId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'creators',
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
    await queryInterface.addIndex('creator_aliases', ['creatorId']);
    await queryInterface.addIndex('creator_aliases', ['name']);
    await queryInterface.addIndex('creator_aliases', ['creatorId', 'name'], {
      unique: true,
    });

    // 3. Migrate existing aliases
    const creators = await queryInterface.sequelize.query(
      'SELECT id, aliases FROM creators WHERE aliases IS NOT NULL',
      { type: Sequelize.QueryTypes.SELECT }
    );

    for (const creator of creators) {
      if (creator.aliases) {
        const aliases = JSON.parse(creator.aliases);
        if (Array.isArray(aliases) && aliases.length > 0) {
          const aliasRecords = aliases.map(alias => ({
            creatorId: creator.id,
            name: alias,
            createdAt: new Date(),
            updatedAt: new Date(),
          }));
          await queryInterface.bulkInsert('creator_aliases', aliasRecords);
        }
      }
    }

    // 4. Drop the aliases column from creators table
    await queryInterface.removeColumn('creators', 'aliases');
  },

  async down(queryInterface, Sequelize) {
    // 1. Add back the aliases column
    await queryInterface.addColumn('creators', 'aliases', {
      type: Sequelize.JSON,
      allowNull: true,
      defaultValue: [],
    });

    // 2. Migrate data back to JSON format
    const creatorAliases = await queryInterface.sequelize.query(
      'SELECT creatorId, name FROM creator_aliases',
      { type: Sequelize.QueryTypes.SELECT }
    );

    // Group aliases by creator
    const aliasesByCreator = creatorAliases.reduce((acc, { creatorId, name }) => {
      if (!acc[creatorId]) {
        acc[creatorId] = [];
      }
      acc[creatorId].push(name);
      return acc;
    }, {});

    // Update each creator with their aliases
    for (const [creatorId, aliases] of Object.entries(aliasesByCreator)) {
      await queryInterface.sequelize.query(
        'UPDATE creators SET aliases = ? WHERE id = ?',
        {
          replacements: [JSON.stringify(aliases), creatorId],
          type: Sequelize.QueryTypes.UPDATE,
        }
      );
    }

    // 3. Drop the creator_aliases table
    await queryInterface.dropTable('creator_aliases');
  },
}; 