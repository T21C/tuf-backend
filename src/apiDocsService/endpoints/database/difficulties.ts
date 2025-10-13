import { EndpointDefinition } from '../../services/DocumentationService.js';

const difficultiesEndpoints: EndpointDefinition[] = [
  {
    path: '/v2/database/difficulties/hash',
    method: 'GET',
    category: 'DIFFICULTIES',
    description: 'Get the current hash of difficulties for cache invalidation',
    responses: {
      '200': 'Current difficulties hash string',
      '500': 'Internal server error'
    }
  },
  {
    path: '/v2/database/difficulties/channels',
    method: 'GET',
    category: 'DIFFICULTIES',
    description: 'Get available announcement channels for difficulty updates',
    requiresAuth: true,
    requiresAdmin: true,
    responses: {
      '200': 'Array of active announcement channels with webhook URLs and labels',
      '500': 'Failed to fetch channels'
    }
  },
  {
    path: '/v2/database/difficulties/channels',
    method: 'POST',
    category: 'DIFFICULTIES',
    description: 'Create a new announcement channel for difficulty notifications',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      body: {
        webhookUrl: 'Discord webhook URL (required) - Must be a valid Discord webhook URL',
        label: 'Channel label (required) - Human-readable name for the channel'
      }
    },
    responses: {
      '201': 'Channel created successfully with ID and metadata',
      '400': 'Missing required fields or invalid webhook URL format',
      '500': 'Failed to create channel due to database error'
    }
  },
  {
    path: '/v2/database/difficulties/channels/:id',
    method: 'PUT',
    category: 'DIFFICULTIES',
    description: 'Update an existing announcement channel configuration',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Channel ID (number) - Unique identifier of the channel to update'
      },
      body: {
        webhookUrl: 'Discord webhook URL (required) - New webhook URL for the channel',
        label: 'Channel label (required) - New human-readable name for the channel'
      }
    },
    responses: {
      '200': 'Channel updated successfully with updated metadata',
      '400': 'Missing required fields or invalid webhook URL format',
      '404': 'Channel not found with the specified ID',
      '500': 'Failed to update channel due to database error'
    }
  },
  {
    path: '/v2/database/difficulties/channels/:id',
    method: 'DELETE',
    category: 'DIFFICULTIES',
    description: 'Delete an announcement channel (soft delete - marks as inactive)',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Channel ID (number) - Unique identifier of the channel to delete'
      }
    },
    responses: {
      '200': 'Channel deleted successfully (soft delete)',
      '404': 'Channel not found with the specified ID',
      '500': 'Failed to delete channel due to database error'
    }
  },
  {
    path: '/v2/database/difficulties/roles',
    method: 'GET',
    category: 'DIFFICULTIES',
    description: 'Get available announcement roles for difficulty notifications',
    requiresAuth: true,
    requiresAdmin: true,
    responses: {
      '200': 'Array of active announcement roles with Discord role IDs and labels',
      '500': 'Failed to fetch roles'
    }
  },
  {
    path: '/v2/database/difficulties/roles',
    method: 'POST',
    category: 'DIFFICULTIES',
    description: 'Create a new announcement role for difficulty notifications',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      body: {
        roleId: 'Discord role ID (required) - Numeric Discord role identifier',
        label: 'Role label (required) - Human-readable name for the role'
      }
    },
    responses: {
      '201': 'Role created successfully with ID and metadata',
      '400': 'Missing required fields or invalid role ID format',
      '500': 'Failed to create role due to database error'
    }
  },
  {
    path: '/v2/database/difficulties/roles/:id',
    method: 'PUT',
    category: 'DIFFICULTIES',
    description: 'Update an existing announcement role configuration',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Role ID (number) - Unique identifier of the role to update'
      },
      body: {
        roleId: 'Discord role ID (required) - New Discord role identifier',
        label: 'Role label (required) - New human-readable name for the role'
      }
    },
    responses: {
      '200': 'Role updated successfully with updated metadata',
      '400': 'Missing required fields or invalid role ID format',
      '404': 'Role not found with the specified ID',
      '500': 'Failed to update role due to database error'
    }
  },
  {
    path: '/v2/database/difficulties/roles/:id',
    method: 'DELETE',
    category: 'DIFFICULTIES',
    description: 'Delete an announcement role (soft delete - marks as inactive)',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Role ID (number) - Unique identifier of the role to delete'
      }
    },
    responses: {
      '200': 'Role deleted successfully (soft delete)',
      '404': 'Role not found with the specified ID',
      '500': 'Failed to delete role due to database error'
    }
  },
  {
    path: '/v2/database/difficulties',
    method: 'GET',
    category: 'DIFFICULTIES',
    description: 'Get all difficulties with their configuration and metadata',
    responses: {
      '200': 'Array of all difficulties with complete configuration including icons, colors, and sort orders',
      '500': 'Internal server error'
    }
  },
  {
    path: '/v2/database/difficulties',
    method: 'POST',
    category: 'DIFFICULTIES',
    description: 'Create a new difficulty with complete configuration',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      body: {
        id: 'Difficulty ID (required) - Unique numeric identifier for the difficulty',
        name: 'Difficulty name (required) - Human-readable name (e.g., "Easy", "Hard")',
        type: 'Difficulty type (required) - Category type (e.g., "standard", "custom")',
        icon: 'Icon URL (required) - URL to the difficulty icon image',
        emoji: 'Emoji (optional) - Unicode emoji representation',
        color: 'Color hex code (optional) - Hex color code (e.g., "#FF0000")',
        baseScore: 'Base score (optional) - Numeric base score for calculations',
        sortOrder: 'Sort order (optional) - Numeric order for display sorting',
        legacy: 'Legacy flag (optional) - Boolean indicating if this is a legacy difficulty',
        legacyIcon: 'Legacy icon URL (optional) - URL to legacy icon image',
        legacyEmoji: 'Legacy emoji (optional) - Legacy emoji representation'
      }
    },
    responses: {
      '201': 'Difficulty created successfully with complete configuration',
      '400': 'Difficulty with this ID or name already exists',
      '500': 'Failed to create difficulty due to database error'
    }
  },
  {
    path: '/v2/database/difficulties/:id',
    method: 'PUT',
    category: 'DIFFICULTIES',
    description: 'Update difficulty details and configuration',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Difficulty ID (number) - Unique identifier of the difficulty to update'
      },
      body: {
        name: 'Difficulty name (optional) - New human-readable name',
        type: 'Difficulty type (optional) - New category type',
        icon: 'Icon URL (optional) - New icon image URL',
        emoji: 'Emoji (optional) - New emoji representation',
        color: 'Color hex code (optional) - New hex color code',
        baseScore: 'Base score (optional) - New numeric base score',
        sortOrder: 'Sort order (optional) - New display sort order',
        legacy: 'Legacy flag (optional) - New legacy status',
        legacyIcon: 'Legacy icon URL (optional) - New legacy icon URL',
        legacyEmoji: 'Legacy emoji (optional) - New legacy emoji'
      }
    },
    responses: {
      '200': 'Difficulty updated successfully with new configuration',
      '400': 'Difficulty with this name already exists',
      '404': 'Difficulty not found with the specified ID',
      '500': 'Failed to update difficulty due to database error'
    }
  },
  {
    path: '/v2/database/difficulties/:id',
    method: 'DELETE',
    category: 'DIFFICULTIES',
    description: 'Delete difficulty with fallback to another difficulty for existing levels',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Difficulty ID to delete (number) - Unique identifier of the difficulty to remove'
      },
      query: {
        fallbackId: 'Fallback difficulty ID (required) - ID of difficulty to reassign existing levels to'
      }
    },
    responses: {
      '200': 'Difficulty deleted successfully with levels reassigned to fallback difficulty',
      '400': 'Fallback difficulty ID is required or same as deleted difficulty',
      '404': 'Difficulty to delete or fallback difficulty not found',
      '500': 'Failed to delete difficulty due to database error'
    }
  },
  {
    path: '/v2/database/difficulties/:id/directives',
    method: 'GET',
    category: 'DIFFICULTIES',
    description: 'Get announcement directives configuration for a specific difficulty',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Difficulty ID (number) - Unique identifier of the difficulty'
      }
    },
    responses: {
      '200': 'Array of announcement directives with actions, triggers, and conditions',
      '404': 'Difficulty not found with the specified ID',
      '500': 'Failed to fetch announcement directives due to database error'
    }
  },
  {
    path: '/v2/database/difficulties/:id/directives',
    method: 'POST',
    category: 'DIFFICULTIES',
    description: 'Configure announcement directives for automatic difficulty notifications',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Difficulty ID (number) - Unique identifier of the difficulty'
      },
      body: {
        directives: 'Array of directive objects (required) - Each directive contains: name, description, mode, triggerType, condition, actions, isActive, firstOfKind'
      }
    },
    responses: {
      '200': 'Directives configured successfully with validation results',
      '400': 'Invalid directive format or validation failed',
      '404': 'Difficulty not found with the specified ID',
      '500': 'Failed to create directives due to database error'
    }
  },
  {
    path: '/v2/database/difficulties/verify-password',
    method: 'HEAD',
    category: 'DIFFICULTIES',
    description: 'Verify super admin password for sensitive difficulty operations',
    requiresAuth: true,
    requiresAdmin: true,
    responses: {
      '200': 'Password verified successfully',
      '401': 'Invalid password provided'
    }
  },
  {
    path: '/v2/database/difficulties/sort-orders',
    method: 'PUT',
    category: 'DIFFICULTIES',
    description: 'Update difficulty sort orders in bulk for reordering display',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      body: {
        sortOrders: 'Array of objects with id and sortOrder (required) - Each object contains difficulty ID and new sort order'
      }
    },
    responses: {
      '200': 'Sort orders updated successfully for all specified difficulties',
      '400': 'Invalid sort orders format or validation failed',
      '500': 'Failed to update sort orders due to database error'
    }
  }
];

export default difficultiesEndpoints;
