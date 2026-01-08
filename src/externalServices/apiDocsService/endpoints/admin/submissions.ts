import { EndpointDefinition } from '../../services/DocumentationService.js';

const submissionsEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/v2/admin/submissions/levels',
    description: 'Get all level submissions',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    responses: {
      '200': 'List of level submissions',
      '500': 'Failed to fetch level submissions'
    }
  },
  {
    method: 'GET',
    path: '/v2/admin/submissions/levels/pending',
    description: 'Get pending level submissions with creator and team request data',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    responses: {
      '200': 'List of pending level submissions with creator/team statistics',
      '500': 'Failed to fetch pending level submissions'
    }
  },
  {
    method: 'GET',
    path: '/v2/admin/submissions/passes',
    description: 'Get all pass submissions',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    responses: {
      '200': 'List of pass submissions with judgements and flags',
      '500': 'Failed to fetch pass submissions'
    }
  },
  {
    method: 'GET',
    path: '/v2/admin/submissions/passes/pending',
    description: 'Get pending pass submissions',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    responses: {
      '200': 'List of pending pass submissions with player, level, and difficulty data',
      '500': 'Failed to fetch pending pass submissions'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/submissions/levels/:id/approve',
    description: 'Approve level submission and create level with rating',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      }
    },
    responses: {
      '200': 'Submission approved, level and rating created successfully',
      '400': 'All creators must be assigned or marked as new',
      '404': 'Submission or referenced creator/team not found',
      '500': 'Failed to process level submission'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/submissions/levels/:id/decline',
    description: 'Decline level submission and clean up CDN files',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      }
    },
    responses: {
      '200': 'Submission declined successfully',
      '404': 'Submission not found',
      '500': 'Failed to process level submission'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/submissions/passes/:id/approve',
    description: 'Approve pass submission and create pass with judgements',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      }
    },
    responses: {
      '200': 'Pass submission approved successfully with pass data',
      '404': 'Submission, level, or difficulty not found',
      '500': 'Failed to process pass submission'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/submissions/passes/:id/decline',
    description: 'Decline pass submission',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      }
    },
    responses: {
      '200': 'Pass submission rejected successfully',
      '500': 'Failed to decline pass submission'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/submissions/passes/:id/assign-player',
    description: 'Assign player to pass submission',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      },
      body: {
        playerId: 'number (required) - Player ID to assign'
      }
    },
    responses: {
      '200': 'Player assigned successfully',
      '404': 'Submission not found',
      '500': 'Failed to assign player'
    }
  },
  {
    method: 'POST',
    path: '/v2/admin/submissions/auto-approve/passes',
    description: 'Auto-approve all pending pass submissions with assigned players',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    responses: {
      '200': 'Auto-approval completed with results for each submission',
      '500': 'Failed to auto-approve submissions'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/submissions/levels/:id/profiles',
    description: 'Update creator and team request profiles for level submission',
    category: 'ADMIN',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      },
      body: {
        creatorRequests: 'array (optional) - Updated creator requests',
        teamRequestData: 'object (optional) - Updated team request data'
      }
    },
    responses: {
      '200': 'Submission profiles updated successfully',
      '404': 'Submission not found',
      '500': 'Failed to update submission profiles'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/submissions/levels/:id/assign-creator',
    description: 'Assign existing creator to level submission credit request',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      },
      body: {
        creatorId: 'number (required) - Creator ID to assign',
        role: 'string (required) - Creator role (charter or vfxer)',
        creditRequestId: 'number (required) - Credit request ID'
      }
    },
    responses: {
      '200': 'Creator assigned successfully',
      '400': 'Missing required fields',
      '404': 'Submission, creator, or credit request not found',
      '500': 'Failed to assign creator'
    }
  },
  {
    method: 'POST',
    path: '/v2/admin/submissions/levels/:id/creators',
    description: 'Create new creator/team and assign to level submission',
    category: 'ADMIN',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      },
      body: {
        name: 'string (required) - Creator/team name',
        aliases: 'array (optional) - Team aliases (for team role only)',
        role: 'string (required) - Role (charter, vfxer, or team)',
        creditRequestId: 'number (required) - Credit request ID'
      }
    },
    responses: {
      '200': 'Creator/team created and assigned successfully',
      '400': 'Missing required fields',
      '404': 'Submission not found',
      '500': 'Failed to create and assign creator/team'
    }
  },
  {
    method: 'POST',
    path: '/v2/admin/submissions/levels/:id/creator-requests',
    description: 'Add new creator request to level submission',
    category: 'ADMIN',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID'
      },
      body: {
        role: 'string (required) - Creator role (charter, vfxer, or team)'
      }
    },
    responses: {
      '200': 'Creator request added successfully',
      '400': 'Role is required',
      '404': 'Submission not found',
      '500': 'Failed to add creator request'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/admin/submissions/levels/:id/creator-requests/:requestId',
    description: 'Remove creator request from level submission',
    category: 'ADMIN',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'number (required) - Submission ID',
        requestId: 'number (required) - Request ID'
      }
    },
    responses: {
      '200': 'Creator request removed successfully',
      '400': 'Cannot remove the last charter',
      '404': 'Submission or request not found',
      '500': 'Failed to remove creator request'
    }
  }
];

export default submissionsEndpoints;
