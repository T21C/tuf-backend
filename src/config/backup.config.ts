export default {
    mysql: {
      backupPath: './backups/mysql',
      retention: {
        hourly: 10,
        daily: 10,
        weekly: 10,
        monthly: 10 
      },
      schedule: {
        hourly: '0 */1 * * *',    // Every 1 hour
        daily: '0 1 * * *',     // Every day at 1 AM
        weekly: '0 2 * * 0',    // Every Sunday at 2 AM
        monthly: '0 3 1 * *'    // 1st of each month at 3 AM
      }
    },
    files: {
      backupPath: './backups/files',
      retention: {
        hourly: 36,
        daily: 14,
        weekly: 10,
        monthly: 10 
      },
      schedule: {
        hourly: '0 */1 * * *',    // Every 1 hour
        daily: '0 1 * * *',     // Every day at 1 AM
        weekly: '0 2 * * 0',    // Every Sunday at 2 AM
        monthly: '0 3 1 * *'    // 1st of each month at 3 AM
      },
      include: [
        'cache/',
        '*.json'
      ],
      exclude: [
        'node_modules',
        'backups',
        '*.log'
      ]
    }
  }