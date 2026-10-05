/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const columns = await queryInterface.describeTable('mod_versions');
    if (!columns.githubUrl) {
      await queryInterface.addColumn('mod_versions', 'githubUrl', {type: Sequelize.TEXT, allowNull: true});
    }
    if (!columns.platformDownloadUrls) {
      await queryInterface.addColumn('mod_versions', 'platformDownloadUrls', {type: Sequelize.JSON, allowNull: true});
    }
  },
  async down(queryInterface) {
    const columns = await queryInterface.describeTable('mod_versions');
    if (columns.platformDownloadUrls) await queryInterface.removeColumn('mod_versions', 'platformDownloadUrls');
    if (columns.githubUrl) await queryInterface.removeColumn('mod_versions', 'githubUrl');
  },
};
