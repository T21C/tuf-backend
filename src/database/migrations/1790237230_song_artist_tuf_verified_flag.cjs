'use strict';

const SONG_ENUM_WITHOUT_TUF = ['declined', 'pending', 'conditional', 'ysmod_only', 'allowed'];
const SONG_ENUM_WITH_TUF = [...SONG_ENUM_WITHOUT_TUF, 'tuf_verified'];
const ARTIST_ENUM_WITHOUT_TUF = [
  'unverified',
  'pending',
  'declined',
  'mostly_declined',
  'mostly_allowed',
  'allowed',
  'ysmod_only',
];
const ARTIST_ENUM_WITH_TUF = [...ARTIST_ENUM_WITHOUT_TUF, 'tuf_verified'];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.addColumn('songs', 'tufVerified', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        after: 'verificationState',
      }, { transaction });

      await queryInterface.addColumn('artists', 'tufVerified', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        after: 'verificationState',
      }, { transaction });

      await queryInterface.addIndex('songs', ['tufVerified'], {
        name: 'songs_tuf_verified',
        transaction,
      });
      await queryInterface.addIndex('artists', ['tufVerified'], {
        name: 'artists_tuf_verified',
        transaction,
      });

      await queryInterface.sequelize.query(
        `UPDATE songs SET tufVerified = 1, verificationState = 'pending' WHERE verificationState = 'tuf_verified';`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `UPDATE artists SET tufVerified = 1, verificationState = 'pending' WHERE verificationState = 'tuf_verified';`,
        { transaction },
      );

      await queryInterface.changeColumn('songs', 'verificationState', {
        type: Sequelize.ENUM(...SONG_ENUM_WITHOUT_TUF),
        allowNull: false,
        defaultValue: 'pending',
      }, { transaction });

      await queryInterface.changeColumn('artists', 'verificationState', {
        type: Sequelize.ENUM(...ARTIST_ENUM_WITHOUT_TUF),
        allowNull: false,
        defaultValue: 'unverified',
      }, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.changeColumn('songs', 'verificationState', {
        type: Sequelize.ENUM(...SONG_ENUM_WITH_TUF),
        allowNull: false,
        defaultValue: 'pending',
      }, { transaction });

      await queryInterface.changeColumn('artists', 'verificationState', {
        type: Sequelize.ENUM(...ARTIST_ENUM_WITH_TUF),
        allowNull: false,
        defaultValue: 'unverified',
      }, { transaction });

      await queryInterface.sequelize.query(
        `UPDATE songs SET verificationState = 'tuf_verified' WHERE tufVerified = 1;`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `UPDATE artists SET verificationState = 'tuf_verified' WHERE tufVerified = 1;`,
        { transaction },
      );

      await queryInterface.removeIndex('songs', 'songs_tuf_verified', { transaction });
      await queryInterface.removeIndex('artists', 'artists_tuf_verified', { transaction });
      await queryInterface.removeColumn('songs', 'tufVerified', { transaction });
      await queryInterface.removeColumn('artists', 'tufVerified', { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
