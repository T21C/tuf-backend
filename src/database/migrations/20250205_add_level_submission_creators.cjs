'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Create junction table for level submission creator requests
    await queryInterface.createTable('level_submission_creator_requests', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      submissionId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'level_submissions',
          key: 'id'
        },
        onDelete: 'CASCADE'
      },
      creatorName: {
        type: Sequelize.STRING,
        allowNull: false
      },
      creatorId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'creators',
          key: 'id'
        }
      },
      role: {
        type: Sequelize.ENUM('charter', 'vfxer'),
        allowNull: false
      },
      isNewRequest: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false
      }
    });

    // Create junction table for level submission team requests
    await queryInterface.createTable('level_submission_team_requests', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      submissionId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'level_submissions',
          key: 'id'
        },
        onDelete: 'CASCADE'
      },
      teamName: {
        type: Sequelize.STRING,
        allowNull: false
      },
      teamId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'teams',
          key: 'id'
        }
      },
      isNewRequest: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false
      }
    });

    // Add indexes with unique names for better query performance
    await queryInterface.addIndex('level_submission_creator_requests', ['submissionId'], {
      name: 'idx_creator_requests_submission_id_20250205'
    });
    await queryInterface.addIndex('level_submission_creator_requests', ['creatorId'], {
      name: 'idx_creator_requests_creator_id_20250205'
    });
    await queryInterface.addIndex('level_submission_creator_requests', ['role'], {
      name: 'idx_creator_requests_role_20250205'
    });
    await queryInterface.addIndex('level_submission_team_requests', ['submissionId'], {
      name: 'idx_team_requests_submission_id_20250205'
    });
    await queryInterface.addIndex('level_submission_team_requests', ['teamId'], {
      name: 'idx_team_requests_team_id_20250205'
    });

    // Remove old columns from level_submissions
    const columns = await queryInterface.describeTable('level_submissions');
    if (columns.charterId) {
      await queryInterface.removeColumn('level_submissions', 'charterId');
    }
    if (columns.charterRequest) {
      await queryInterface.removeColumn('level_submissions', 'charterRequest');
    }
    if (columns.vfxerId) {
      await queryInterface.removeColumn('level_submissions', 'vfxerId');
    }
    if (columns.vfxerRequest) {
      await queryInterface.removeColumn('level_submissions', 'vfxerRequest');
    }
    if (columns.teamId) {
      await queryInterface.removeColumn('level_submissions', 'teamId');
    }
    if (columns.teamRequest) {
      await queryInterface.removeColumn('level_submissions', 'teamRequest');
    }
  },

  async down(queryInterface, Sequelize) {
    // Add back old columns to level_submissions
    await queryInterface.addColumn('level_submissions', 'charterId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {
        model: 'creators',
        key: 'id'
      }
    });
    await queryInterface.addColumn('level_submissions', 'charterRequest', {
      type: Sequelize.BOOLEAN,
      defaultValue: false
    });
    await queryInterface.addColumn('level_submissions', 'vfxerId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {
        model: 'creators',
        key: 'id'
      }
    });
    await queryInterface.addColumn('level_submissions', 'vfxerRequest', {
      type: Sequelize.BOOLEAN,
      defaultValue: false
    });
    await queryInterface.addColumn('level_submissions', 'teamId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {
        model: 'teams',
        key: 'id'
      }
    });
    await queryInterface.addColumn('level_submissions', 'teamRequest', {
      type: Sequelize.BOOLEAN,
      defaultValue: false
    });

    // Drop tables (this will automatically remove the indexes)
    await queryInterface.dropTable('level_submission_creator_requests');
    await queryInterface.dropTable('level_submission_team_requests');
  }
}; 