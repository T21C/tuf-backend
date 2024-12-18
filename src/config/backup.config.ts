export default {
    mysql: {
      backupPath: './backups/mysql',
      retention: {
        daily: 7,    // Keep daily backups for 7 days
        weekly: 4,   // Keep weekly backups for 4 weeks
        monthly: 3   // Keep monthly backups for 3 months
      },
      schedule: {
        daily: '0 1 * * *',     // Every day at 1 AM
        weekly: '0 2 * * 0',    // Every Sunday at 2 AM
        monthly: '0 3 1 * *'    // 1st of each month at 3 AM
      }
    },
    files: {
      backupPath: './backups/files',
      include: [
        'cache/',
        '*.json'
      ],
      exclude: [
        'node_modules',
        'backups',
        '*.log'
      ],
      schedule: '0 4 * * *' // Every day at 4 AM
    }
  }