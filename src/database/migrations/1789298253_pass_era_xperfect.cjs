'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'passes',
        'adofaiVersion',
        {
          type: Sequelize.SMALLINT,
          allowNull: false,
          defaultValue: 2,
          comment: 'Frozen ADOFAI era: 1=v2, 2=pre-3.4.0, 3=3.4.0+',
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'passes',
        'passMetaFlags',
        {
          type: Sequelize.BIGINT,
          allowNull: false,
          defaultValue: 0,
          comment: 'Processing bitfield (low bits); bit0=midspin perfects removed',
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'passes',
        'isXPerfectMode',
        {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        { transaction },
      );

      await queryInterface.addColumn(
        'pass_submission_flags',
        'adofaiVersion',
        {
          type: Sequelize.SMALLINT,
          allowNull: false,
          defaultValue: 2,
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'pass_submission_flags',
        'passMetaFlags',
        {
          type: Sequelize.BIGINT,
          allowNull: false,
          defaultValue: 0,
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'pass_submission_flags',
        'isXPerfectMode',
        {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        { transaction },
      );

      await queryInterface.addColumn(
        'judgements',
        'perfectMinus',
        {
          type: Sequelize.BIGINT.UNSIGNED,
          allowNull: false,
          defaultValue: 0,
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'judgements',
        'perfectPlus',
        {
          type: Sequelize.BIGINT.UNSIGNED,
          allowNull: false,
          defaultValue: 0,
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'pass_submission_judgements',
        'perfectMinus',
        {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'pass_submission_judgements',
        'perfectPlus',
        {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        { transaction },
      );

      await queryInterface.sequelize.query(
        `
        UPDATE passes
        SET adofaiVersion = CASE WHEN IFNULL(isAdofaiV2, 0) = 1 THEN 1 ELSE 2 END
        `,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `
        UPDATE pass_submission_flags
        SET adofaiVersion = CASE WHEN IFNULL(isAdofaiV2, 0) = 1 THEN 1 ELSE 2 END
        `,
        { transaction },
      );

      await queryInterface.addIndex('passes', ['adofaiVersion'], {
        name: 'idx_passes_adofai_version',
        transaction,
      });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.removeIndex('passes', 'idx_passes_adofai_version', { transaction });
      await queryInterface.removeColumn('pass_submission_judgements', 'perfectPlus', { transaction });
      await queryInterface.removeColumn('pass_submission_judgements', 'perfectMinus', { transaction });
      await queryInterface.removeColumn('judgements', 'perfectPlus', { transaction });
      await queryInterface.removeColumn('judgements', 'perfectMinus', { transaction });
      await queryInterface.removeColumn('pass_submission_flags', 'isXPerfectMode', { transaction });
      await queryInterface.removeColumn('pass_submission_flags', 'passMetaFlags', { transaction });
      await queryInterface.removeColumn('pass_submission_flags', 'adofaiVersion', { transaction });
      await queryInterface.removeColumn('passes', 'isXPerfectMode', { transaction });
      await queryInterface.removeColumn('passes', 'passMetaFlags', { transaction });
      await queryInterface.removeColumn('passes', 'adofaiVersion', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
