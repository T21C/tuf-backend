import { EndpointDefinition } from '../../../services/DocumentationService.js';

const packsEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/v2/database/levels/packs',
    description: 'List all level packs with filtering, sorting, and pagination',
    category: 'PACKS',
    parameters: {
      query: {
        query: 'string (optional) - Search query string supporting field searches (name:, owner:, levelid:, viewmode:, pinned:)',
        viewMode: 'number (optional) - View mode filter (requires super admin)',
        pinned: 'boolean (optional) - Filter by pinned status',
        myLikesOnly: 'boolean (optional) - Only return packs favorited by current user',
        offset: 'number (optional, default: 0) - Pagination offset',
        limit: 'number (optional, default: 30, max: 100) - Pagination limit',
        sort: 'string (optional, default: RECENT) - Sort field (RECENT, NAME, FAVORITES, LEVELS)',
        order: 'string (optional, default: DESC) - Sort order (ASC, DESC)'
      }
    },
    responses: {
      '200': 'List of packs with pagination information',
      '500': 'Failed to fetch packs'
    }
  },
  {
    method: 'GET',
    path: '/v2/database/levels/packs/:id',
    description: 'Get specific pack with its content tree. Returns pack with items in tree structure or flat list.',
    category: 'PACKS',
    parameters: {
      path: {
        id: 'string (required) - Pack linkCode'
      },
      query: {
        tree: 'boolean (optional, default: true) - Return items as tree structure (true) or flat list (false)'
      }
    },
    responses: {
      '200': 'Pack details with content tree or flat list. Includes cleared status for levels if user is authenticated.',
      '403': 'Access denied - pack is private or forced private',
      '404': 'Pack not found',
      '500': 'Failed to fetch pack'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/levels/packs',
    description: 'Create new pack. Non-admins can only create private (2) or link-only (1) packs. Link code is auto-generated.',
    category: 'PACKS',
    requiresAuth: true,
    parameters: {
      body: {
        name: 'string (required) - Pack name (max 50 packs per user)',
        iconUrl: 'string (optional) - Icon URL',
        cssFlags: 'number (optional, default: 0) - CSS flags for styling',
        viewMode: 'number (optional) - View mode: 0=PUBLIC (admin only), 1=LINKONLY, 2=PRIVATE (default for non-admins), 3=FORCED_PRIVATE (not allowed)',
        isPinned: 'boolean (optional, default: false, admin only) - Pinned status'
      }
    },
    responses: {
      '201': 'Pack created successfully with auto-generated linkCode',
      '400': 'Pack name required, max packs reached, or forced private not allowed',
      '403': 'Only administrators can create public packs or set pin status',
      '401': 'Authentication required',
      '500': 'Failed to create pack'
    }
  },
  {
    method: 'PUT',
    path: '/v2/database/levels/packs/:id',
    description: 'Update pack. Owner can edit unless forced private. Admins can edit any pack.',
    category: 'PACKS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'string (required) - Pack linkCode'
      },
      body: {
        name: 'string (optional) - Pack name (cannot be empty)',
        iconUrl: 'string (optional) - Icon URL',
        cssFlags: 'number (optional) - CSS flags for styling',
        viewMode: 'number (optional) - View mode (admin only for public/forced private)',
        isPinned: 'boolean (optional, admin only) - Pinned status'
      }
    },
    responses: {
      '200': 'Pack updated successfully',
      '400': 'Invalid pack ID/link code or pack name cannot be empty',
      '401': 'Authentication required',
      '403': 'Access denied, admin-only operation, or cannot modify view mode of admin-locked pack',
      '404': 'Pack not found',
      '500': 'Failed to update pack'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/database/levels/packs/:id',
    description: 'Delete pack. Owner can delete unless forced private. Admins can delete any pack.',
    category: 'PACKS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'string (required) - Pack linkCode'
      }
    },
    responses: {
      '204': 'Pack deleted successfully (no content)',
      '400': 'Invalid pack ID or link code',
      '401': 'Authentication required',
      '403': 'Access denied',
      '404': 'Pack not found',
      '500': 'Failed to delete pack'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/levels/packs/:id/icon',
    description: 'Upload pack icon. Replaces existing icon if present. Max file size: 5MB.',
    category: 'PACKS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'string (required) - Pack linkCode'
      },
      body: {
        icon: 'file (required) - Icon image file (JPEG, PNG, WebP only, max 5MB)'
      }
    },
    responses: {
      '200': 'Icon uploaded successfully with fileId and URLs',
      '400': 'No file uploaded, invalid file type, or invalid pack ID/link code',
      '401': 'Authentication required',
      '403': 'Access denied',
      '404': 'Pack not found',
      '500': 'Failed to upload pack icon'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/database/levels/packs/:id/icon',
    description: 'Remove pack icon. Deletes icon from CDN and sets iconUrl to null.',
    category: 'PACKS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'string (required) - Pack linkCode'
      }
    },
    responses: {
      '200': 'Icon removed successfully',
      '400': 'No icon to remove or invalid pack ID/link code',
      '401': 'Authentication required',
      '403': 'Access denied',
      '404': 'Pack not found',
      '500': 'Failed to remove pack icon'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/levels/packs/:id/items',
    description: 'Add item(s) to pack. Can add a folder or one/multiple levels. For levels, parentId must be a valid folder if provided. Max 1000 items per pack.',
    category: 'PACKS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'string (required) - Pack linkCode'
      },
      body: {
        type: 'string (required) - Item type: "folder" or "level"',
        name: 'string (required for folder) - Folder name (must be unique in same parent)',
        levelIds: 'number | number[] | string (required for level) - Single level ID, array of IDs, or comma-separated string of IDs',
        parentId: 'number (optional) - Parent folder ID (must reference valid folder in same pack)',
        sortOrder: 'number (optional) - Sort order for the item(s). Auto-increments if multiple levelIds provided.'
      }
    },
    responses: {
      '201': 'Item(s) added successfully. Returns single folder object or array of level objects with referencedLevel data.',
      '400': 'Invalid pack ID/link code, invalid type, folder name required/duplicate, invalid level IDs, level already in pack, invalid parent folder, or max items exceeded',
      '401': 'Authentication required',
      '403': 'Access denied',
      '404': 'Pack not found or one or more levels not found',
      '500': 'Failed to add item to pack'
    }
  },
  {
    method: 'PUT',
    path: '/v2/database/levels/packs/:id/items/:itemId',
    description: 'Update pack item. Currently only supports renaming folders. Name must be unique in same parent.',
    category: 'PACKS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'string (required) - Pack linkCode',
        itemId: 'number (required) - Item ID'
      },
      body: {
        name: 'string (optional, folders only) - New folder name (cannot be empty)'
      }
    },
    responses: {
      '200': 'Item updated successfully',
      '400': 'Invalid pack ID/link code, invalid item ID, folder name cannot be empty, or duplicate folder name in same parent',
      '401': 'Authentication required',
      '403': 'Access denied',
      '404': 'Pack not found or item not found in pack',
      '500': 'Failed to update pack item'
    }
  },
  {
    method: 'PUT',
    path: '/v2/database/levels/packs/:id/tree',
    description: 'Update entire pack tree structure. Recursively flattens tree and updates parentId and sortOrder for all items. Validates circular references.',
    category: 'PACKS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'string (required) - Pack linkCode'
      },
      body: {
        items: 'array (required) - Tree structure with nested items. Each item must have id and optional children array.'
      }
    },
    responses: {
      '200': 'Tree updated successfully. Returns updated tree with referencedLevel and curation data.',
      '400': 'Invalid pack ID/link code, items must be an array, some items do not belong to pack, or circular reference detected',
      '401': 'Authentication required',
      '403': 'Access denied',
      '404': 'Pack not found',
      '500': 'Failed to update pack tree'
    }
  },
  {
    method: 'GET',
    path: '/v2/database/levels/packs/:id/favorite',
    description: 'Check if pack is favorited by current user',
    category: 'PACKS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'string (required) - Pack linkCode'
      }
    },
    responses: {
      '200': 'Returns { isFavorited: boolean }',
      '400': 'Invalid pack ID or link code',
      '401': 'Authentication required',
      '500': 'Failed to check favorite status'
    }
  },
  {
    method: 'PUT',
    path: '/v2/database/levels/packs/:id/favorite',
    description: 'Set pack favorite status explicitly. Creates/removes favorite record. Cannot favorite admin-locked (FORCED_PRIVATE) packs.',
    category: 'PACKS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'string (required) - Pack linkCode'
      },
      body: {
        favorited: 'boolean (required) - true to add favorite, false to remove'
      }
    },
    responses: {
      '200': 'Returns { success: true, favorited: boolean, favorites: number }',
      '400': 'Invalid pack ID/link code or favorited must be a boolean',
      '401': 'Unauthorized',
      '403': 'Cannot favorite admin-locked pack',
      '404': 'Pack not found',
      '500': 'Failed to set pack favorite status'
    }
  },
  {
    method: 'GET',
    path: '/v2/database/levels/packs/favorites',
    description: 'Get all packs favorited by current user. Returns packs sorted by name.',
    category: 'PACKS',
    requiresAuth: true,
    responses: {
      '200': 'Returns { packs: array } with pack owner data',
      '401': 'Authentication required',
      '500': 'Failed to fetch favorited packs'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/database/levels/packs/:id/items/:itemId',
    description: 'Remove item from pack. Cascades to children due to foreign key constraint.',
    category: 'PACKS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'string (required) - Pack linkCode',
        itemId: 'number (required) - Item ID to delete'
      }
    },
    responses: {
      '204': 'Item deleted successfully (no content)',
      '400': 'Invalid pack ID/link code or invalid item ID',
      '401': 'Authentication required',
      '403': 'Access denied',
      '404': 'Pack not found or item not found in pack',
      '500': 'Failed to delete pack item'
    }
  },
  {
    method: 'PUT',
    path: '/v2/database/levels/packs/:id/items/reorder',
    description: 'Reorder multiple items and optionally change their parent. Updates sortOrder and parentId for each item.',
    category: 'PACKS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'string (required) - Pack linkCode'
      },
      body: {
        items: 'array (required) - Array of objects with { id: number, sortOrder: number, parentId?: number }'
      }
    },
    responses: {
      '200': 'Returns { success: true }',
      '400': 'Invalid pack ID/link code or items must be an array',
      '401': 'Authentication required',
      '403': 'Access denied',
      '404': 'Pack not found',
      '500': 'Failed to reorder pack items'
    }
  }
];

export default packsEndpoints;

