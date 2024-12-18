export default {
    mysql: {
      backupPath: './backups/mysql',
      retention: {
        hourly: 3, // Keep hourly backups for 3 days
        daily: 7,    // Keep daily backups for 7 days
        weekly: 4,   // Keep weekly backups for 4 weeks
        monthly: 3   // Keep monthly backups for 3 months
      },
      schedule: {
        hourly: '0 */4 * * *',    // Every 4 hours
        daily: '0 1 * * *',     // Every day at 1 AM
        weekly: '0 2 * * 0',    // Every Sunday at 2 AM
        monthly: '0 3 1 * *'    // 1st of each month at 3 AM
      }
    },
    files: {
      backupPath: './backups/files',
      retention: {
        hourly: 3, // Keep hourly backups for 3 days
        daily: 7,    // Keep daily backups for 7 days
        weekly: 4,   // Keep weekly backups for 4 weeks
        monthly: 3   // Keep monthly backups for 3 months
      },
      schedule: {
        hourly: '0 */4 * * *',    // Every 4 hours
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