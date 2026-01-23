'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Create artists table
      await queryInterface.createTable('artists', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true
        },
        name: {
          type: Sequelize.STRING(255),
          allowNull: false
        },
        avatarUrl: {
          type: Sequelize.TEXT,
          allowNull: true,
          comment: 'CDN URL or external URL for artist avatar'
        },
        verificationState: {
          type: Sequelize.ENUM('unverified', 'pending', 'verified'),
          allowNull: false,
          defaultValue: 'unverified'
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        }
      }, { transaction });

      // Create artistAliases table
      await queryInterface.createTable('artist_aliases', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true
        },
        artistId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'artists',
            key: 'id'
          },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE'
        },
        alias: {
          type: Sequelize.STRING(255),
          allowNull: false
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        }
      }, { transaction });

      // Create artistLinks table
      await queryInterface.createTable('artist_links', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true
        },
        artistId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'artists',
            key: 'id'
          },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE'
        },
        link: {
          type: Sequelize.TEXT,
          allowNull: false
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        }
      }, { transaction });

      // Create artistEvidences table
      await queryInterface.createTable('artist_evidences', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true
        },
        artistId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'artists',
            key: 'id'
          },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE'
        },
        link: {
          type: Sequelize.TEXT,
          allowNull: false
        },
        type: {
          type: Sequelize.ENUM('official', 'social', 'music_platform', 'other'),
          allowNull: false,
          defaultValue: 'other'
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        }
      }, { transaction });

      // Create songs table
      await queryInterface.createTable('songs', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true
        },
        name: {
          type: Sequelize.STRING(255),
          allowNull: false
        },
        verificationState: {
          type: Sequelize.ENUM('unverified', 'pending', 'verified'),
          allowNull: false,
          defaultValue: 'unverified'
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        }
      }, { transaction });

      // Create songCredits table (many-to-many: songs <-> artists)
      await queryInterface.createTable('song_credits', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true
        },
        songId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'songs',
            key: 'id'
          },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE'
        },
        artistId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'artists',
            key: 'id'
          },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE'
        },
        role: {
          type: Sequelize.STRING(50),
          allowNull: true,
          comment: 'e.g., primary, featured, remixer'
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        }
      }, { transaction });

      // Create songAliases table
      await queryInterface.createTable('song_aliases', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true
        },
        songId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'songs',
            key: 'id'
          },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE'
        },
        alias: {
          type: Sequelize.STRING(255),
          allowNull: false
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        }
      }, { transaction });

      // Create songLinks table
      await queryInterface.createTable('song_links', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true
        },
        songId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'songs',
            key: 'id'
          },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE'
        },
        link: {
          type: Sequelize.TEXT,
          allowNull: false
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        }
      }, { transaction });

      // Create songEvidences table
      await queryInterface.createTable('song_evidences', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true
        },
        songId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'songs',
            key: 'id'
          },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE'
        },
        link: {
          type: Sequelize.TEXT,
          allowNull: false
        },
        type: {
          type: Sequelize.ENUM('official', 'music_platform', 'video', 'other'),
          allowNull: false,
          defaultValue: 'other'
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        }
      }, { transaction });

      // Create level_submission_song_requests table
      await queryInterface.createTable('level_submission_song_requests', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true
        },
        submissionId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'level_submissions',
            key: 'id'
          },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE'
        },
        songId: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: {
            model: 'songs',
            key: 'id'
          },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE'
        },
        songName: {
          type: Sequelize.STRING(255),
          allowNull: true,
          comment: 'For new song requests'
        },
        isNewRequest: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false
        },
        requiresEvidence: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
          comment: 'Set to true if selected song is declined'
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        }
      }, { transaction });

      // Create level_submission_artist_requests table
      await queryInterface.createTable('level_submission_artist_requests', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true
        },
        submissionId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'level_submissions',
            key: 'id'
          },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE'
        },
        artistId: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: {
            model: 'artists',
            key: 'id'
          },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE'
        },
        artistName: {
          type: Sequelize.STRING(255),
          allowNull: true,
          comment: 'For new artist requests'
        },
        isNewRequest: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false
        },
        requiresEvidence: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
          comment: 'Set to true if selected artist is declined'
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        }
      }, { transaction });

      // Create level_submission_evidence table
      await queryInterface.createTable('level_submission_evidence', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true
        },
        submissionId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'level_submissions',
            key: 'id'
          },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE'
        },
        link: {
          type: Sequelize.TEXT,
          allowNull: false,
          comment: 'CDN URL (extract fileId using getFileIdFromCdnUrl() when needed)'
        },
        type: {
          type: Sequelize.ENUM('song', 'artist'),
          allowNull: false,
          comment: 'Whether evidence is for song or artist'
        },
        requestId: {
          type: Sequelize.INTEGER,
          allowNull: true,
          comment: 'Reference to song_request or artist_request ID'
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        }
      }, { transaction });

      // Add indexes
      await queryInterface.addIndex('artists', ['name'], { transaction });
      await queryInterface.addIndex('artists', ['verificationState'], { transaction });
      // Note: Case-insensitive uniqueness will be enforced at application level

      await queryInterface.addIndex('artist_aliases', ['artistId'], { transaction });
      await queryInterface.addIndex('artist_aliases', ['alias'], { transaction });
      // Note: Case-insensitive uniqueness will be enforced at application level

      await queryInterface.addIndex('artist_links', ['artistId'], { transaction });
      await queryInterface.addIndex('artist_evidences', ['artistId'], { transaction });
      await queryInterface.addIndex('artist_evidences', ['type'], { transaction });

      await queryInterface.addIndex('songs', ['name'], { transaction });
      await queryInterface.addIndex('songs', ['verificationState'], { transaction });

      await queryInterface.addIndex('song_credits', ['songId'], { transaction });
      await queryInterface.addIndex('song_credits', ['artistId'], { transaction });
      await queryInterface.addIndex('song_credits', ['songId', 'artistId', 'role'], {
        unique: true,
        name: 'song_credits_songid_artistid_role_unique',
        transaction
      });

      await queryInterface.addIndex('song_aliases', ['songId'], { transaction });
      await queryInterface.addIndex('song_aliases', ['alias'], { transaction });
      // Note: Case-insensitive uniqueness will be enforced at application level

      await queryInterface.addIndex('song_links', ['songId'], { transaction });
      await queryInterface.addIndex('song_evidences', ['songId'], { transaction });
      await queryInterface.addIndex('song_evidences', ['type'], { transaction });

      await queryInterface.addIndex('level_submission_song_requests', ['submissionId'], { transaction });
      await queryInterface.addIndex('level_submission_song_requests', ['songId'], { transaction });
      await queryInterface.addIndex('level_submission_artist_requests', ['submissionId'], { transaction });
      await queryInterface.addIndex('level_submission_artist_requests', ['artistId'], { transaction });
      await queryInterface.addIndex('level_submission_evidence', ['submissionId'], { transaction });
      await queryInterface.addIndex('level_submission_evidence', ['type'], { transaction });
      await queryInterface.addIndex('level_submission_evidence', ['requestId'], { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Drop tables in reverse order (respecting foreign key dependencies)
      await queryInterface.dropTable('level_submission_evidence', { transaction });
      await queryInterface.dropTable('level_submission_artist_requests', { transaction });
      await queryInterface.dropTable('level_submission_song_requests', { transaction });
      await queryInterface.dropTable('song_evidences', { transaction });
      await queryInterface.dropTable('song_links', { transaction });
      await queryInterface.dropTable('song_aliases', { transaction });
      await queryInterface.dropTable('song_credits', { transaction });
      await queryInterface.dropTable('songs', { transaction });
      await queryInterface.dropTable('artist_evidences', { transaction });
      await queryInterface.dropTable('artist_links', { transaction });
      await queryInterface.dropTable('artist_aliases', { transaction });
      await queryInterface.dropTable('artists', { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
