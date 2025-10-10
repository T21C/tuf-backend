import { EndpointDefinition } from '../../services/DocumentationService.js';

const backupEndpoints: EndpointDefinition[] = [
  {
    method: 'HEAD',
    path: '/v2/admin/backup/upload/:type/validate',
    description: 'Validate upload credentials before uploading backup',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        type: 'string (required) - Backup type (mysql or files)'
      }
    },
    responses: {
      '200': 'Credentials valid',
      '400': 'Invalid backup type',
      '401': 'Unauthorized',
      '403': 'Forbidden - requires super admin with password',
      '500': 'Upload validation failed'
    }
  },
  {
    method: 'POST',
    path: '/v2/admin/backup/upload/:type',
    description: 'Upload backup file',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        type: 'string (required) - Backup type (mysql or files)'
      },
      body: {
        backup: 'file (required) - Backup file (max 500MB)'
      }
    },
    responses: {
      '200': 'Backup uploaded successfully with new filename',
      '400': 'No file uploaded or invalid backup type',
      '401': 'Unauthorized',
      '403': 'Forbidden - requires super admin with password',
      '500': 'Failed to upload backup'
    }
  },
  {
    method: 'POST',
    path: '/v2/admin/backup/create/:target',
    description: 'Trigger manual backup creation',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        target: 'string (required) - Backup target (all, mysql, or files)'
      },
      body: {
        type: 'string (optional, default: manual) - Backup type label'
      }
    },
    responses: {
      '200': 'Backup(s) created successfully with file paths',
      '401': 'Unauthorized',
      '403': 'Forbidden - requires super admin with password',
      '500': 'Backup creation failed'
    }
  },
  {
    method: 'GET',
    path: '/v2/admin/backup/list',
    description: 'List all available backups',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    responses: {
      '200': 'List of MySQL and file backups with metadata (filename, size, created date)',
      '401': 'Unauthorized',
      '403': 'Forbidden - requires super admin',
      '500': 'Failed to list backups'
    }
  },
  {
    method: 'POST',
    path: '/v2/admin/backup/restore/:type/:filename',
    description: 'Restore backup from file',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        type: 'string (required) - Backup type (mysql or files)',
        filename: 'string (required) - Backup filename'
      }
    },
    responses: {
      '200': 'Backup restored successfully',
      '400': 'Invalid backup type',
      '401': 'Unauthorized',
      '403': 'Forbidden - requires super admin with password',
      '404': 'Backup file not found',
      '500': 'Failed to restore backup'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/admin/backup/delete/:type/:filename',
    description: 'Delete backup file',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        type: 'string (required) - Backup type (mysql or files)',
        filename: 'string (required) - Backup filename'
      }
    },
    responses: {
      '200': 'Backup deleted successfully',
      '400': 'Invalid backup type',
      '401': 'Unauthorized',
      '403': 'Forbidden - requires super admin with password',
      '404': 'Backup file not found',
      '500': 'Failed to delete backup'
    }
  },
  {
    method: 'POST',
    path: '/v2/admin/backup/rename/:type/:filename',
    description: 'Rename backup file',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        type: 'string (required) - Backup type (mysql or files)',
        filename: 'string (required) - Current backup filename'
      },
      body: {
        newName: 'string (required) - New filename'
      }
    },
    responses: {
      '200': 'Backup renamed successfully',
      '400': 'Invalid backup type or name already exists',
      '401': 'Unauthorized',
      '403': 'Forbidden - requires super admin with password',
      '404': 'Backup file not found',
      '500': 'Failed to rename backup'
    }
  },
  {
    method: 'GET',
    path: '/v2/admin/backup/download/:type/:filename',
    description: 'Download backup file',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        type: 'string (required) - Backup type (mysql or files)',
        filename: 'string (required) - Backup filename'
      }
    },
    responses: {
      '200': 'Backup file stream',
      '400': 'Invalid backup type',
      '401': 'Unauthorized',
      '403': 'Forbidden - requires super admin with password',
      '404': 'Backup file not found',
      '500': 'Failed to download backup'
    }
  }
];

export default backupEndpoints;
