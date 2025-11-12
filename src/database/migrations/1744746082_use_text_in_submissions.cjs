'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Drop existing indexes if they exist

    try{
      await queryInterface.removeIndex('level_submissions', 'level_submissions_charter');
    } catch(error){
      console.log(error);
    }

    try{
      await queryInterface.removeIndex('level_submissions', 'level_submissions_artist');
    } catch(error){
      console.log(error);
    }

    // Level Submissions

    await queryInterface.changeColumn('level_submissions', 'artist', {
      type: Sequelize.TEXT,
      allowNull: false,
    });

    await queryInterface.changeColumn('level_submissions', 'charter', {
      type: Sequelize.TEXT,
      allowNull: false,
    });
    
    await queryInterface.changeColumn('level_submissions', 'diff', {
      type: Sequelize.TEXT,
      allowNull: false,
    });
    
    await queryInterface.changeColumn('level_submissions', 'song', {
      type: Sequelize.TEXT,
      allowNull: false,
    });
    
    await queryInterface.changeColumn('level_submissions', 'team', {
      type: Sequelize.TEXT,
      defaultValue: '',
    });
    
    await queryInterface.changeColumn('level_submissions', 'vfxer', {
      type: Sequelize.TEXT,
      defaultValue: '',
    });
    
    await queryInterface.changeColumn('level_submissions', 'videoLink', {
      type: Sequelize.TEXT,
      allowNull: false,
    });

    await queryInterface.changeColumn('level_submissions', 'directDL', {
      type: Sequelize.TEXT,
    });

    await queryInterface.changeColumn('level_submissions', 'wsLink', {
      type: Sequelize.TEXT,
    });

    await queryInterface.changeColumn('level_submissions', 'submitterDiscordUsername', {
      type: Sequelize.TEXT,
    });

    await queryInterface.changeColumn('level_submissions', 'submitterDiscordPfp', {
      type: Sequelize.TEXT,
      defaultValue: '',
    });

    await queryInterface.changeColumn('level_submissions', 'submitterDiscordId', {
      type: Sequelize.TEXT,
    });

    // Recreate indexes with proper key lengths for TEXT fields
    await queryInterface.addIndex('level_submissions', [{
      name: 'artist',
      length: 191
    }], {
      name: 'level_submissions_artist'
    });

    await queryInterface.addIndex('level_submissions', [{
      name: 'charter',
      length: 191
    }], {
      name: 'level_submissions_charter'
    });


    // Level Submission Creator Requests

    await queryInterface.changeColumn('level_submission_creator_requests', 'creatorName', {
      type: Sequelize.TEXT,
      allowNull: false,
    });
    

    // Pass Submissions

    try{
      await queryInterface.removeIndex('pass_submissions', 'pass_submissions_passer');
    } catch(error){
      console.log(error);
    }

    try{
      await queryInterface.removeIndex('pass_submissions', 'pass_submissions_video_link');
    } catch(error){
      console.log(error);
    }

    await queryInterface.changeColumn('pass_submissions', 'passer', {
      type: Sequelize.TEXT,
      allowNull: false,
    });
    
    await queryInterface.changeColumn('pass_submissions', 'videoLink', {
      type: Sequelize.TEXT,
      allowNull: false,
    });
    
    await queryInterface.changeColumn('pass_submissions', 'submitterDiscordUsername', {
      type: Sequelize.TEXT,
      allowNull: true,
    });

    await queryInterface.addIndex('pass_submissions', [{
      name: 'passer',
      length: 191
    }], {
      name: 'pass_submissions_passer'
    });

    await queryInterface.addIndex('pass_submissions', [{
      name: 'videoLink',
      length: 191
    }], {
      name: 'pass_submissions_video_link'
    });


  },

  async down(queryInterface, Sequelize) {
  }
}; 