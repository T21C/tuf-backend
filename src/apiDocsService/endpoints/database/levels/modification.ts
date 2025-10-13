import { EndpointDefinition } from '../../../services/DocumentationService.js';

const modificationEndpoints: EndpointDefinition[] = [
  {
    method: 'PUT',
    path: '/v2/database/levels/:id',
    description: 'Update level information with comprehensive validation and async operations',
    category: 'LEVELS',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Level ID'
      },
      body: {
        song: 'string (optional) - Song name',
        artist: 'string (optional) - Artist name',
        creator: 'string (optional) - Creator name',
        charter: 'string (optional) - Charter name',
        vfxer: 'string (optional) - VFX artist name',
        team: 'string (optional) - Team name',
        diffId: 'integer (optional) - Difficulty ID',
        previousDiffId: 'integer (optional) - Previous difficulty ID',
        baseScore: 'integer (optional) - Base score',
        previousBaseScore: 'integer (optional) - Previous base score',
        videoLink: 'string (optional) - Video link',
        dlLink: 'string (optional) - Download link',
        workshopLink: 'string (optional) - Workshop link',
        publicComments: 'string (optional) - Public comments',
        rerateNum: 'string (optional) - Rerate number',
        toRate: 'boolean (optional) - Mark for rating',
        rerateReason: 'string (optional) - Rerate reason',
        isDeleted: 'boolean (optional) - Deleted flag',
        isHidden: 'boolean (optional) - Hidden flag',
        isAnnounced: 'boolean (optional) - Announced flag',
        isExternallyAvailable: 'boolean (optional) - Externally available flag'
      }
    },
    responses: {
      '200': 'Level updated successfully',
      '400': 'Invalid level ID',
      '401': 'Unauthorized',
      '403': 'Forbidden - cannot modify CDN-managed download link',
      '404': 'Level not found',
      '500': 'Failed to update level'
    }
  },
  {
    method: 'PUT',
    path: '/v2/database/levels/:id/toRate',
    description: 'Toggle whether a level is marked for rating',
    category: 'LEVELS',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Level ID'
      }
    },
    responses: {
      '200': 'Rating status toggled successfully',
      '400': 'Invalid level ID',
      '401': 'Unauthorized',
      '403': 'Forbidden - requires super admin',
      '404': 'Level not found',
      '500': 'Failed to toggle rating status'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/database/levels/:id',
    description: 'Soft delete a level (mark as deleted)',
    category: 'LEVELS',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Level ID'
      }
    },
    responses: {
      '200': 'Level soft deleted successfully',
      '204': 'Level deleted successfully',
      '400': 'Invalid level ID',
      '401': 'Unauthorized',
      '403': 'Forbidden - requires super admin',
      '404': 'Level not found',
      '500': 'Failed to soft delete level'
    }
  },
  {
    method: 'PATCH',
    path: '/v2/database/levels/:id/restore',
    description: 'Restore a soft-deleted level',
    category: 'LEVELS',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Level ID'
      }
    },
    responses: {
      '200': 'Level restored successfully',
      '401': 'Unauthorized',
      '403': 'Forbidden - requires super admin',
      '404': 'Level not found',
      '500': 'Failed to restore level'
    }
  },
  {
    method: 'PATCH',
    path: '/v2/database/levels/:id/toggle-hidden',
    description: 'Toggle the hidden status of a level',
    category: 'LEVELS',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Level ID'
      }
    },
    responses: {
      '200': 'Hidden status toggled successfully',
      '401': 'Unauthorized',
      '403': 'Forbidden - requires super admin',
      '404': 'Level not found',
      '500': 'Failed to toggle level hidden status'
    }
  },
  {
    method: 'PUT',
    path: '/v2/database/levels/:id/like',
    description: 'Like or unlike a level',
    category: 'LEVELS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'integer (required) - Level ID'
      },
      body: {
        action: 'string (required) - Action to perform (like or unlike)'
      }
    },
    responses: {
      '200': 'Like status updated successfully',
      '400': 'Invalid level ID, action, or already liked/unliked',
      '401': 'Unauthorized',
      '403': 'Cannot like deleted level',
      '404': 'Level not found',
      '500': 'Failed to toggle level like'
    }
  },
  {
    method: 'PUT',
    path: '/v2/database/levels/:id/rating-accuracy-vote',
    description: 'Submit a vote on the rating accuracy of a PGU level',
    category: 'LEVELS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'integer (required) - Level ID'
      },
      body: {
        vote: 'integer (required) - Vote value between -5 and 5'
      }
    },
    responses: {
      '200': 'Rating accuracy vote submitted successfully',
      '400': 'Invalid vote value, non-PGU level, or must pass level first',
      '401': 'Unauthorized',
      '404': 'Level not found',
      '500': 'Failed to vote on rating accuracy'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/levels/:id/upload',
    description: 'Upload a level file to CDN and update level download link',
    category: 'MEDIA',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Level ID'
      },
      body: {
        fileId: 'string (required) - File ID from chunked upload',
        fileName: 'string (required) - Original file name',
        fileSize: 'integer (required) - File size in bytes'
      }
    },
    responses: {
      '200': 'Level file uploaded successfully',
      '400': 'Invalid level ID or missing file information',
      '401': 'Unauthorized',
      '403': 'Forbidden - requires super admin',
      '404': 'Level not found',
      '500': 'Failed to upload level file'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/levels/:id/select-level',
    description: 'Select a specific level file from a multi-level zip',
    category: 'MEDIA',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Level ID'
      },
      body: {
        selectedLevel: 'string (required) - Name of the level file to select'
      }
    },
    responses: {
      '200': 'Level file selected successfully',
      '400': 'Invalid level ID or missing selected level',
      '401': 'Unauthorized',
      '403': 'Forbidden - requires super admin',
      '404': 'Level or file not found',
      '500': 'Failed to select level file'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/database/levels/:id/upload',
    description: 'Delete a level file from CDN and remove download link',
    category: 'MEDIA',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Level ID'
      }
    },
    responses: {
      '200': 'Level file deleted successfully',
      '400': 'Invalid level ID or no CDN-managed file',
      '401': 'Unauthorized',
      '403': 'Forbidden - requires super admin',
      '404': 'Level not found',
      '500': 'Failed to delete level file'
    }
  }
];

export default modificationEndpoints;
