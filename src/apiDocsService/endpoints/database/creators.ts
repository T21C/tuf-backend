import { EndpointDefinition } from '../../services/DocumentationService.js';

const creatorsEndpoints: EndpointDefinition[] = [
  {
    path: '/v2/database/creators',
    method: 'GET',
    category: 'CREATORS',
    description: 'Get all creators with pagination, search, and filtering options',
    parameters: {
      query: {
        page: 'Page number (default: 1)',
        limit: 'Results per page (default: 100, max: 200)',
        search: 'Search term for creator names and aliases',
        hideVerified: 'Hide verified creators (default: false)',
        excludeAliases: 'Exclude alias matches (default: false)',
        sort: 'Sort order: NAME_ASC, NAME_DESC, ID_ASC, ID_DESC, CHARTS_ASC, CHARTS_DESC'
      }
    },
    responses: {
      '200': 'Paginated list of creators with aliases and level counts',
      '500': 'Failed to fetch creators'
    }
  },
  {
    path: '/v2/database/creators/byId/:creatorId',
    method: 'GET',
    category: 'CREATORS',
    description: 'Get creator details by ID',
    parameters: {
      path: {
        creatorId: 'Creator ID (number)'
      }
    },
    responses: {
      '200': 'Creator object with levels, credits, and aliases',
      '404': 'Creator not found',
      '500': 'Failed to fetch creator details'
    }
  },
  {
    path: '/v2/database/creators/teams/byId/:teamId',
    method: 'GET',
    category: 'CREATORS',
    description: 'Get team details by ID with members and levels',
    parameters: {
      path: {
        teamId: 'Team ID (number)'
      }
    },
    responses: {
      '200': 'Team object with members and levels',
      '404': 'Team not found',
      '500': 'Failed to fetch team details'
    }
  },
  {
    path: '/v2/database/creators/levels-audit',
    method: 'GET',
    category: 'CREATORS',
    description: 'Get levels audit with legacy and current creators',
    parameters: {
      query: {
        offset: 'Pagination offset (default: 0)',
        limit: 'Results per page (default: 50, max: 200)',
        search: 'Search query for levels',
        hideVerified: 'Hide verified levels',
        excludeAliases: 'Exclude alias matches'
      }
    },
    responses: {
      '200': 'Levels audit with creator information',
      '500': 'Failed to fetch levels audit'
    }
  },
  {
    path: '/v2/database/creators',
    method: 'POST',
    category: 'CREATORS',
    description: 'Create a new creator',
    parameters: {
      body: {
        name: 'Creator name (required)',
        aliases: 'Array of creator aliases (optional)'
      }
    },
    responses: {
      '201': 'Created creator with aliases',
      '400': 'Creator name is required',
      '500': 'Failed to create creator'
    }
  },
  {
    path: '/v2/database/creators/level/:levelId',
    method: 'PUT',
    category: 'CREATORS',
    description: 'Update level creators',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        levelId: 'Level ID (number)'
      },
      body: {
        creators: 'Array of creator objects with id and role'
      }
    },
    responses: {
      '200': 'Level creators updated successfully',
      '404': 'Level not found',
      '500': 'Failed to update level creators'
    }
  },
  {
    path: '/v2/database/creators/level/:levelId/verify',
    method: 'POST',
    category: 'CREATORS',
    description: 'Verify level credits',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        levelId: 'Level ID (number)'
      }
    },
    responses: {
      '200': 'Level credits verified successfully',
      '404': 'Level not found',
      '500': 'Failed to verify level credits'
    }
  },
  {
    path: '/v2/database/creators/level/:levelId/unverify',
    method: 'POST',
    category: 'CREATORS',
    description: 'Unverify level credits',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        levelId: 'Level ID (number)'
      }
    },
    responses: {
      '200': 'Level credits unverified successfully',
      '404': 'Level not found',
      '500': 'Failed to unverify level credits'
    }
  },
  {
    path: '/v2/database/creators/merge',
    method: 'POST',
    category: 'CREATORS',
    description: 'Merge two creators',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      body: {
        sourceId: 'Source creator ID (required)',
        targetId: 'Target creator ID (required)'
      }
    },
    responses: {
      '200': 'Creators merged successfully',
      '400': 'Source and target IDs are required',
      '404': 'Creator not found',
      '500': 'Failed to merge creators'
    }
  },
  {
    path: '/v2/database/creators/split',
    method: 'POST',
    category: 'CREATORS',
    description: 'Split a creator into multiple creators',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      body: {
        creatorId: 'Creator ID to split (required)',
        newNames: 'Array of new creator names (required)',
        roles: 'Array of roles for new creators (optional)'
      }
    },
    responses: {
      '200': 'Creator split successfully with new creators',
      '404': 'Creator not found',
      '500': 'Failed to split creator'
    }
  },
  {
    path: '/v2/database/creators/:id',
    method: 'PUT',
    category: 'CREATORS',
    description: 'Update creator details',
    parameters: {
      path: {
        id: 'Creator ID (number)'
      },
      body: {
        name: 'Creator name (optional)',
        aliases: 'Array of aliases (optional)',
        userId: 'User ID (optional)',
        isVerified: 'Verification status (optional)'
      }
    },
    responses: {
      '200': 'Updated creator with associations',
      '500': 'Failed to update creator'
    }
  },
  {
    path: '/v2/database/creators/teams',
    method: 'GET',
    category: 'CREATORS',
    description: 'Get all teams with search',
    parameters: {
      query: {
        search: 'Search term for team names and aliases'
      }
    },
    responses: {
      '200': 'Array of teams with members and aliases',
      '500': 'Failed to fetch teams'
    }
  },
  {
    path: '/v2/database/creators/level/:levelId/team',
    method: 'PUT',
    category: 'CREATORS',
    description: 'Create or update team for level',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        levelId: 'Level ID (number)'
      },
      body: {
        teamId: 'Existing team ID (optional)',
        name: 'Team name (optional)',
        members: 'Array of creator IDs (optional)'
      }
    },
    responses: {
      '200': 'Team updated successfully',
      '404': 'Level not found',
      '500': 'Failed to update team'
    }
  },
  {
    path: '/v2/database/creators/level/:levelId/team',
    method: 'DELETE',
    category: 'CREATORS',
    description: 'Delete team association from level',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        levelId: 'Level ID (number)'
      }
    },
    responses: {
      '200': 'Team association removed successfully',
      '404': 'Level not found',
      '500': 'Failed to remove team'
    }
  },
  {
    path: '/v2/database/creators/team/:teamId',
    method: 'DELETE',
    category: 'CREATORS',
    description: 'Delete team',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        teamId: 'Team ID (number)'
      },
      query: {
        levelId: 'Level ID for context (optional)'
      }
    },
    responses: {
      '200': 'Team deleted successfully',
      '404': 'Team not found',
      '500': 'Failed to delete team'
    }
  },
  {
    path: '/v2/database/creators/team/:teamId',
    method: 'GET',
    category: 'CREATORS',
    description: 'Get team details',
    parameters: {
      path: {
        teamId: 'Team ID (number)'
      }
    },
    responses: {
      '200': 'Team object with members',
      '404': 'Team not found',
      '500': 'Failed to fetch team'
    }
  },
  {
    path: '/v2/database/creators/:creatorId/discord/:userId',
    method: 'PUT',
    category: 'CREATORS',
    description: 'Link Discord account to creator',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        creatorId: 'Creator ID (number)',
        userId: 'User ID (number)'
      }
    },
    responses: {
      '200': 'Discord account linked successfully',
      '404': 'Creator or user not found',
      '500': 'Failed to link Discord account'
    }
  },
  {
    path: '/v2/database/creators/:creatorId/discord',
    method: 'DELETE',
    category: 'CREATORS',
    description: 'Unlink Discord account from creator',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        creatorId: 'Creator ID (number)'
      }
    },
    responses: {
      '200': 'Discord account unlinked successfully',
      '404': 'Creator not found',
      '500': 'Failed to unlink Discord account'
    }
  },
  {
    path: '/v2/database/creators/search/:name',
    method: 'GET',
    category: 'CREATORS',
    description: 'Search creators by name or alias',
    parameters: {
      path: {
        name: 'Search term (URL encoded)'
      }
    },
    responses: {
      '200': 'Array of matching creators with aliases',
      '400': 'Invalid search parameter encoding',
      '500': 'Failed to search creators'
    }
  },
  {
    path: '/v2/database/creators/teams',
    method: 'POST',
    category: 'CREATORS',
    description: 'Create new team',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      body: {
        name: 'Team name (required)',
        aliases: 'Array of team aliases (optional)',
        description: 'Team description (optional)'
      }
    },
    responses: {
      '201': 'Team created successfully',
      '400': 'Team name is required or conflicts with existing team',
      '500': 'Failed to create team'
    }
  },
  {
    path: '/v2/database/creators/teams/search/:name',
    method: 'GET',
    category: 'CREATORS',
    description: 'Search teams by name or alias',
    parameters: {
      path: {
        name: 'Search term'
      }
    },
    responses: {
      '200': 'Array of matching teams with members and aliases',
      '500': 'Failed to search teams'
    }
  }
];

export default creatorsEndpoints; 