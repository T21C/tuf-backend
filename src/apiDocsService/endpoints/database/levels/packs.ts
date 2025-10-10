import { EndpointDefinition } from '../../../services/DocumentationService.js';

const packsEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/v2/database/levels/packs',
    description: 'List all level packs with filtering, sorting, and pagination',
    category: 'PACKS',
    parameters: {
      query: {
        query: 'string (optional) - Search query string',
        viewMode: 'number (optional) - View mode filter (requires super admin)',
        pinned: 'boolean (optional) - Filter by pinned status',
        myLikesOnly: 'boolean (optional) - Only return packs favorited by current user',
        offset: 'number (optional, default: 0) - Pagination offset',
        limit: 'number (optional, default: 30, max: 200) - Pagination limit',
        sort: 'string (optional, default: RECENT) - Sort field (RECENT, NAME, FAVORITES, LEVELS)',
        order: 'string (optional, default: DESC) - Sort order (ASC, DESC)'
      }
    },
    responses: {
      '200': 'List of packs with pagination information',
      '500': 'Internal server error'
    }
  },
  {
    method: 'GET',
    path: '/v2/database/levels/packs/:id',
    description: 'Get specific pack with its content tree',
    category: 'PACKS',
    parameters: {
      path: {
        id: 'string/number (required) - Pack ID or link code'
      }
    },
    responses: {
      '200': 'Pack details with content tree',
      '403': 'Pack is private and user does not have access',
      '404': 'Pack not found',
      '500': 'Failed to fetch pack'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/levels/packs',
    description: 'Create new pack',
    category: 'PACKS',
    requiresAuth: true,
    parameters: {
      body: {
        name: 'string (required) - Pack name',
        description: 'string (optional) - Pack description',
        tags: 'array (optional) - Pack tags',
        viewMode: 'number (optional, default: 0) - View mode (0: Public, 1: Unlisted, 2: Private)',
        isPinned: 'boolean (optional, default: false) - Pinned status',
        linkCode: 'string (optional) - Custom link code'
      }
    },
    responses: {
      '201': 'Pack created successfully',
      '400': 'Invalid pack data or link code already exists',
      '401': 'Authentication required',
      '500': 'Failed to create pack'
    }
  },
  {
    method: 'PUT',
    path: '/v2/database/levels/packs/:id',
    description: 'Update pack',
    category: 'PACKS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'string/number (required) - Pack ID or link code'
      },
      body: {
        name: 'string (optional) - Pack name',
        description: 'string (optional) - Pack description',
        tags: 'array (optional) - Pack tags',
        viewMode: 'number (optional) - View mode',
        isPinned: 'boolean (optional) - Pinned status',
        linkCode: 'string (optional) - Custom link code'
      }
    },
    responses: {
      '200': 'Pack updated successfully',
      '400': 'Invalid pack data',
      '401': 'Authentication required',
      '403': 'User does not have permission to edit this pack',
      '404': 'Pack not found',
      '500': 'Failed to update pack'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/database/levels/packs/:id',
    description: 'Delete pack',
    category: 'PACKS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'string/number (required) - Pack ID or link code'
      }
    },
    responses: {
      '200': 'Pack deleted successfully',
      '401': 'Authentication required',
      '403': 'User does not have permission to delete this pack',
      '404': 'Pack not found',
      '500': 'Failed to delete pack'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/levels/packs/:id/icon',
    description: 'Upload pack icon',
    category: 'PACKS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'string/number (required) - Pack ID or link code'
      },
      body: {
        icon: 'file (required) - Icon image file (JPEG, PNG, WebP, SVG)'
      }
    },
    responses: {
      '200': 'Icon uploaded successfully',
      '400': 'No icon file uploaded or invalid file type',
      '401': 'Authentication required',
      '403': 'User does not have permission to edit this pack',
      '404': 'Pack not found',
      '500': 'Failed to upload icon'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/database/levels/packs/:id/icon',
    description: 'Remove pack icon',
    category: 'PACKS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'string/number (required) - Pack ID or link code'
      }
    },
    responses: {
      '200': 'Icon removed successfully',
      '401': 'Authentication required',
      '403': 'User does not have permission to edit this pack',
      '404': 'Pack not found',
      '500': 'Failed to remove icon'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/levels/packs/:id/items',
    description: 'Add item (folder or level) to pack',
    category: 'PACKS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'string/number (required) - Pack ID or link code'
      },
      body: {
        type: 'string (required) - Item type (folder or level)',
        name: 'string (required for folder) - Folder name',
        levelId: 'number (required for level) - Level ID',
        parentId: 'number (optional) - Parent folder ID'
      }
    },
    responses: {
      '201': 'Item added successfully',
      '400': 'Invalid item data',
      '401': 'Authentication required',
      '403': 'User does not have permission to edit this pack',
      '404': 'Pack or level not found',
      '500': 'Failed to add item'
    }
  },
  {
    method: 'PUT',
    path: '/v2/database/levels/packs/:id/items/:itemId',
    description: 'Update pack item (rename folder or change parent)',
    category: 'PACKS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'string/number (required) - Pack ID or link code',
        itemId: 'number (required) - Item ID'
      },
      body: {
        name: 'string (optional) - New folder name',
        parentId: 'number (optional) - New parent folder ID'
      }
    },
    responses: {
      '200': 'Item updated successfully',
      '400': 'Invalid item data',
      '401': 'Authentication required',
      '403': 'User does not have permission to edit this pack',
      '404': 'Pack or item not found',
      '500': 'Failed to update item'
    }
  },
  {
    method: 'PUT',
    path: '/v2/database/levels/packs/:id/tree',
    description: 'Update entire pack tree structure (batch update)',
    category: 'PACKS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'string/number (required) - Pack ID or link code'
      },
      body: {
        tree: 'array (required) - Complete tree structure with items and their order'
      }
    },
    responses: {
      '200': 'Tree updated successfully',
      '400': 'Invalid tree structure',
      '401': 'Authentication required',
      '403': 'User does not have permission to edit this pack',
      '404': 'Pack not found',
      '500': 'Failed to update tree'
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
        id: 'string/number (required) - Pack ID or link code'
      }
    },
    responses: {
      '200': 'Favorite status',
      '401': 'Authentication required',
      '404': 'Pack not found',
      '500': 'Failed to check favorite status'
    }
  },
  {
    method: 'PUT',
    path: '/v2/database/levels/packs/:id/favorite',
    description: 'Toggle pack favorite status',
    category: 'PACKS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'string/number (required) - Pack ID or link code'
      }
    },
    responses: {
      '200': 'Favorite status updated',
      '401': 'Authentication required',
      '404': 'Pack not found',
      '500': 'Failed to update favorite status'
    }
  },
  {
    method: 'GET',
    path: '/v2/database/levels/packs/favorites',
    description: 'Get all packs favorited by current user',
    category: 'PACKS',
    requiresAuth: true,
    responses: {
      '200': 'List of favorited packs',
      '401': 'Authentication required',
      '500': 'Failed to fetch favorites'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/database/levels/packs/:id/items/:itemId',
    description: 'Remove item from pack',
    category: 'PACKS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'string/number (required) - Pack ID or link code',
        itemId: 'number (required) - Item ID'
      }
    },
    responses: {
      '200': 'Item removed successfully',
      '401': 'Authentication required',
      '403': 'User does not have permission to edit this pack',
      '404': 'Pack or item not found',
      '500': 'Failed to remove item'
    }
  },
  {
    method: 'PUT',
    path: '/v2/database/levels/packs/:id/items/reorder',
    description: 'Reorder items within pack',
    category: 'PACKS',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'string/number (required) - Pack ID or link code'
      },
      body: {
        itemIds: 'array (required) - Ordered array of item IDs'
      }
    },
    responses: {
      '200': 'Items reordered successfully',
      '400': 'Invalid item IDs',
      '401': 'Authentication required',
      '403': 'User does not have permission to edit this pack',
      '404': 'Pack not found',
      '500': 'Failed to reorder items'
    }
  }
];

export default packsEndpoints;

