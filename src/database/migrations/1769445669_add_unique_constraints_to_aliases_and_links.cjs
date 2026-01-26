'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {

      await queryInterface.changeColumn('song_aliases', 'alias', {
        type: Sequelize.STRING(255),
        allowNull: false,
      });
      await queryInterface.changeColumn('artist_aliases', 'alias', {
        type: Sequelize.STRING(255),
        allowNull: false,
      });
      await queryInterface.changeColumn('song_links', 'link', {
        type: Sequelize.STRING(255),
        allowNull: false,
      });
      await queryInterface.changeColumn('artist_links', 'link', {
        type: Sequelize.STRING(255),
        allowNull: false,
      });
      // === SONG ALIASES ===
      // Remove duplicate song aliases (keep lowest id for each songId+alias combination)
      /*  
      await queryInterface.sequelize.query(`
        DELETE sa1 FROM song_aliases sa1
        INNER JOIN song_aliases sa2 
        WHERE sa1.id > sa2.id 
        AND sa1.songId = sa2.songId 
        AND sa1.alias = sa2.alias
      `, { transaction });
      */

        await queryInterface.addConstraint('song_aliases', {
          type: 'UNIQUE',
          name: 'song_aliases_songId_alias_unique',
          fields: ['songId', 'alias'],
          unique: true,
        }, { transaction });


      // === ARTIST ALIASES ===
      /*
      // Remove duplicate artist aliases (keep lowest id for each artistId+alias combination)
      await queryInterface.sequelize.query(`
        DELETE aa1 FROM artist_aliases aa1
        INNER JOIN artist_aliases aa2 
        WHERE aa1.id > aa2.id 
        AND aa1.artistId = aa2.artistId 
        AND aa1.alias = aa2.alias
      `, { transaction });
      */

      // Add unique constraint on artistId + alias

        await queryInterface.addConstraint('artist_aliases', {
          type: 'UNIQUE',
          name: 'artist_aliases_artistId_alias_unique',
          fields: ['artistId', 'alias'],
          unique: true,
        }, { transaction });

      // === SONG LINKS ===
      // Remove duplicate song links (keep lowest id for each songId+link combination)
      /*
      await queryInterface.sequelize.query(`
        DELETE sl1 FROM song_links sl1
        INNER JOIN song_links sl2 
        WHERE sl1.id > sl2.id 
        AND sl1.songId = sl2.songId 
        AND sl1.link = sl2.link
      `, { transaction });
      */
      // Add unique constraint on songId + link
        await queryInterface.addConstraint('song_links', {
          type: 'UNIQUE',
          name: 'song_links_songId_link_unique',
          fields: ['songId', 'link'],
          unique: true,
        }, { transaction });


      // === ARTIST LINKS ===
      // Remove duplicate artist links (keep lowest id for each artistId+link combination)
      /*
      await queryInterface.sequelize.query(`
        DELETE al1 FROM artist_links al1
        INNER JOIN artist_links al2 
        WHERE al1.id > al2.id 
        AND al1.artistId = al2.artistId 
        AND al1.link = al2.link
      `, { transaction });
      */
      // Add unique constraint on artistId + link
      await queryInterface.addConstraint('artist_links', {
        type: 'UNIQUE',
        name: 'artist_links_artistId_link_unique',
        fields: ['artistId', 'link'],
        unique: true,
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
      // Remove unique constraints
      await queryInterface.removeConstraint('song_aliases', 'song_aliases_songId_alias_unique', { transaction });
      await queryInterface.removeConstraint('artist_aliases', 'artist_aliases_artistId_alias_unique', { transaction });
      await queryInterface.removeConstraint('song_links', 'song_links_songId_link_unique', { transaction });
      await queryInterface.removeConstraint('artist_links', 'artist_links_artistId_link_unique', { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
