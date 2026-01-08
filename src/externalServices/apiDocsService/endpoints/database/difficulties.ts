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
  },
  {
    path: '/v2/database/difficulties/tags/sort-orders',
    method: 'PUT',
    category: 'DIFFICULTIES',
    description: 'Update tag sort orders in bulk for reordering tags within groups',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      body: {
        sortOrders: 'Array of objects with id and sortOrder (required) - Each object contains tag ID and new sort order'
      }
    },
    responses: {
      '200': 'Tag sort orders updated successfully',
      '400': 'Invalid sort orders format or missing id/sortOrder',
      '500': 'Failed to update tag sort orders'
    }
  },
  {
    path: '/v2/database/difficulties/tags/group-sort-orders',
    method: 'PUT',
    category: 'DIFFICULTIES',
    description: 'Update group sort orders in bulk for reordering tag groups. Empty string or null represents ungrouped tags.',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      body: {
        groups: 'Array of objects with name and sortOrder (required) - Each object contains group name (empty string for ungrouped) and new group sort order'
      }
    },
    responses: {
      '200': 'Group sort orders updated successfully',
      '400': 'Invalid groups format or missing name/sortOrder',
      '500': 'Failed to update group sort orders'
    }
  },
  {
    path: '/v2/database/difficulties/tags',
    method: 'GET',
    category: 'DIFFICULTIES',
    description: 'Get all level tags ordered by group, sort order, and name',
    responses: {
      '200': 'Array of all tags with complete configuration including name, icon, color, group, sortOrder, and groupSortOrder',
      '500': 'Failed to fetch tags'
    }
  },
  {
    path: '/v2/database/difficulties/tags',
    method: 'POST',
    category: 'DIFFICULTIES',
    description: 'Create a new level tag. Icon can be uploaded as a file or provided as a URL. If icon is null, tag will have no icon.',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      body: {
        name: 'string (required) - Tag name (must be unique)',
        color: 'string (required) - Hex color code (e.g., "#FF5733")',
        icon: 'string | file (optional) - Icon URL or file upload. Pass "null" to create tag without icon',
        group: 'string (optional) - Group name for organizing tags. If not provided, tag will be ungrouped'
      }
    },
    responses: {
      '201': 'Tag created successfully with complete configuration',
      '400': 'Missing required fields, invalid color format, duplicate tag name, or icon upload failed',
      '500': 'Failed to create tag'
    }
  },
  {
    path: '/v2/database/difficulties/tags/:id',
    method: 'PUT',
    category: 'DIFFICULTIES',
    description: 'Update a level tag. Icon can be updated by uploading a file, set to null to remove, or left unchanged. All fields are optional.',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Tag ID (number, 1-20 digits) - Unique identifier of the tag to update'
      },
      body: {
        name: 'string (optional) - New tag name (must be unique if changed)',
        color: 'string (optional) - New hex color code (e.g., "#FF5733")',
        icon: 'string | file | null (optional) - New icon URL, file upload, or "null" to remove icon',
        group: 'string | null (optional) - New group name or null for ungrouped'
      }
    },
    responses: {
      '200': 'Tag updated successfully with new configuration',
      '400': 'Invalid color format, duplicate tag name, or icon upload failed',
      '404': 'Tag not found',
      '500': 'Failed to update tag'
    }
  },
  {
    path: '/v2/database/difficulties/tags/:id',
    method: 'DELETE',
    category: 'DIFFICULTIES',
    description: 'Delete a level tag. Removes all tag assignments from levels and deletes the icon from CDN if present.',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Tag ID (number, 1-20 digits) - Unique identifier of the tag to delete'
      }
    },
    responses: {
      '200': 'Tag deleted successfully with all assignments removed',
      '404': 'Tag not found',
      '500': 'Failed to delete tag'
    }
  },
  {
    path: '/v2/database/difficulties/levels/:levelId/tags',
    method: 'GET',
    category: 'DIFFICULTIES',
    description: 'Get all tags assigned to a specific level',
    parameters: {
      path: {
        levelId: 'Level ID (number, 1-20 digits) - Unique identifier of the level'
      }
    },
    responses: {
      '200': 'Array of tags assigned to the level, ordered by name',
      '404': 'Level not found',
      '500': 'Failed to fetch level tags'
    }
  },
  {
    path: '/v2/database/difficulties/levels/:levelId/tags',
    method: 'POST',
    category: 'DIFFICULTIES',
    description: 'Assign tags to a level. Replaces all existing tag assignments with the provided tag IDs. Empty array removes all tags.',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        levelId: 'Level ID (number, 1-20 digits) - Unique identifier of the level'
      },
      body: {
        tagIds: 'Array of numbers (required) - Array of tag IDs to assign. Empty array removes all tags'
      }
    },
    responses: {
      '200': 'Tags assigned successfully. Returns array of updated tags assigned to the level',
      '400': 'tagIds must be an array or one or more tag IDs are invalid',
      '404': 'Level not found',
      '500': 'Failed to assign tags to level'
    }
  }
];

export default difficultiesEndpoints;
