export default {
  mysql: {
    backupPath: process.env.MYSQL_BACKUP_PATH || './backups/mysql',
    retention: {
      hourly: 24,
      daily: 24,  
      weekly: 10,
      monthly: 10,
    },
    schedule: {
      hourly: '0 */1 * * *', // Every 1 hour
      daily: '0 1 * * *', // Every day at 1 AM
      weekly: '0 2 * * 0', // Every Sunday at 2 AM
      monthly: '0 3 1 * *', // 1st of each month at 3 AM
    },
  },
  files: {
    backupPath: process.env.FILES_BACKUP_PATH || './backups/files',
    retention: {
      hourly: 10,
      daily: 14,  
      weekly: 14,
      monthly: 10,
    },
    schedule: {
      hourly: '0 */1 * * *', // Every 1 hour
      daily: '0 1 * * *', // Every day at 1 AM
      weekly: '0 2 * * 0', // Every Sunday at 2 AM
      monthly: '0 3 1 * *', // 1st of each month at 3 AM
    },
    include: ['cache/icons', '*.json'],
    exclude: ['node_modules', 'backups', '*.log'],
  },
};
