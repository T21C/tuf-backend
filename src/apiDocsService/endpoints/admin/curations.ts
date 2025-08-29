import { EndpointDefinition } from '../../services/DocumentationService.js';

const curationsEndpoints: EndpointDefinition[] = [
  // Curation Management
  {
    method: 'GET',
    path: '/v2/admin/curations',
    description: 'Get all curations with pagination and filters',
    category: 'ADMIN',
    requiresAuth: false,
    parameters: {
      query: {
        page: 'number (optional) - Page number',
        limit: 'number (optional) - Results per page',
        typeId: 'number (optional) - Filter by curation type ID',
        levelId: 'number (optional) - Filter by level ID',
        search: 'string (optional) - Search query',
        excludeIds: 'array (optional) - IDs to exclude'
      }
    },
    responses: {
      '200': 'Paginated list of curations',
      '500': 'Failed to fetch curations'
    }
  },
  {
    method: 'POST',
    path: '/v2/admin/curations',
    description: 'Create new curation',
    category: 'ADMIN',
    requiresAuth: true,
    parameters: {
      body: {
        levelId: 'number (required) - Level ID to curate'
      }
    },
    responses: {
      '201': 'Curation created successfully',
      '400': 'Level ID is required',
      '404': 'Level not found',
      '409': 'Level is already curated',
      '403': 'No permission to assign any curation types',
      '500': 'Failed to create curation'
    }
  },
  {
    method: 'GET',
    path: '/v2/admin/curations/:id',
    description: 'Get single curation',
    category: 'ADMIN',
    requiresAuth: false,
    parameters: {
      path: {
        id: 'number (required) - Curation ID'
      }
    },
    responses: {
      '200': 'Curation details',
      '404': 'Curation not found',
      '500': 'Failed to fetch curation'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/curations/:id',
    description: 'Update curation',
    category: 'ADMIN',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'number (required) - Curation ID'
      },
      body: {
        shortDescription: 'string (optional) - Short description',
        description: 'string (optional) - Full description',
        previewLink: 'string (optional) - Preview image URL',
        customCSS: 'string (optional) - Custom CSS',
        customColor: 'string (optional) - Custom color',
        typeId: 'number (optional) - Curation type ID'
      }
    },
    responses: {
      '200': 'Curation updated successfully',
      '404': 'Curation not found',
      '500': 'Failed to update curation'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/admin/curations/:id',
    description: 'Delete curation',
    category: 'ADMIN',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'number (required) - Curation ID'
      }
    },
    responses: {
      '200': 'Curation deleted successfully',
      '404': 'Curation not found',
      '500': 'Failed to delete curation'
    }
  },

  // Curation Types Management
  {
    method: 'GET',
    path: '/v2/admin/curations/types',
    description: 'Get all curation types',
    category: 'ADMIN',
    requiresAuth: false,
    responses: {
      '200': 'List of curation types',
      '500': 'Failed to fetch curation types'
    }
  },
  {
    method: 'POST',
    path: '/v2/admin/curations/types',
    description: 'Create curation type',
    category: 'ADMIN',
    requiresAuth: true,
    requiresSuperAdmin: true,
    parameters: {
      body: {
        name: 'string (required) - Type name',
        icon: 'string (optional) - Icon URL',
        color: 'string (optional) - Color (default: #ffffff)',
        abilities: 'string (optional) - Abilities bitfield'
      }
    },
    responses: {
      '201': 'Curation type created successfully',
      '400': 'Name is required',
      '409': 'Curation type with this name already exists',
      '500': 'Failed to create curation type'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/curations/types/:id',
    description: 'Update curation type',
    category: 'ADMIN',
    requiresAuth: true,
    requiresSuperAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Curation type ID'
      },
      body: {
        name: 'string (optional) - Type name',
        icon: 'string (optional) - Icon URL',
        color: 'string (optional) - Color',
        abilities: 'string (optional) - Abilities bitfield'
      }
    },
    responses: {
      '200': 'Curation type updated successfully',
      '404': 'Curation type not found',
      '409': 'Curation type with this name already exists',
      '500': 'Failed to update curation type'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/admin/curations/types/:id',
    description: 'Delete curation type',
    category: 'ADMIN',
    requiresAuth: true,
    requiresSuperAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Curation type ID'
      }
    },
    responses: {
      '204': 'Curation type deleted successfully',
      '404': 'Curation type not found',
      '500': 'Failed to delete curation type'
    }
  },
  {
    method: 'POST',
    path: '/v2/admin/curations/types/:id/icon',
    description: 'Upload curation type icon',
    category: 'MEDIA',
    requiresAuth: true,
    requiresSuperAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Curation type ID'
      },
      body: {
        icon: 'file (required) - Icon image file'
      }
    },
    responses: {
      '200': 'Icon uploaded successfully',
      '400': 'No icon file uploaded',
      '404': 'Curation type not found',
      '500': 'Failed to upload icon'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/admin/curations/types/:id/icon',
    description: 'Delete curation type icon',
    category: 'ADMIN',
    requiresAuth: true,
    requiresSuperAdmin: true,
    parameters: {
      path: {
        id: 'number (required) - Curation type ID'
      }
    },
    responses: {
      '200': 'Icon removed successfully',
      '404': 'Curation type not found',
      '500': 'Failed to delete icon'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/curations/types/sort-orders',
    description: 'Update curation type sort orders',
    category: 'ADMIN',
    requiresAuth: true,
    requiresSuperAdmin: true,
    parameters: {
      body: {
        sortOrders: 'array (required) - Array of {id, sortOrder} objects'
      }
    },
    responses: {
      '200': 'Sort orders updated successfully',
      '400': 'Sort orders array is required',
      '500': 'Failed to update sort orders'
    }
  },

  // Curation Schedules
  {
    method: 'GET',
    path: '/v2/admin/curations/schedules',
    description: 'Get curation schedules',
    category: 'ADMIN',
    requiresAuth: false,
    parameters: {
      query: {
        weekStart: 'string (optional) - Week start date'
      }
    },
    responses: {
      '200': 'List of curation schedules',
      '500': 'Failed to fetch curation schedules'
    }
  },
  {
    method: 'POST',
    path: '/v2/admin/curations/schedules',
    description: 'Create curation schedule',
    category: 'ADMIN',
    requiresAuth: true,
    parameters: {
      body: {
        curationId: 'number (required) - Curation ID',
        weekStart: 'string (required) - Week start date',
        listType: 'string (required) - List type (primary/secondary)',
        position: 'number (required) - Position (0-9)'
      }
    },
    responses: {
      '201': 'Curation schedule created successfully',
      '400': 'Required fields missing or invalid',
      '404': 'Curation not found',
      '409': 'Schedule conflict',
      '500': 'Failed to create curation schedule'
    }
  },
  {
    method: 'PUT',
    path: '/v2/admin/curations/schedules/:id',
    description: 'Update curation schedule',
    category: 'ADMIN',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'number (required) - Schedule ID'
      },
      body: {
        position: 'number (optional) - Position (0-9)',
        isActive: 'boolean (optional) - Active status'
      }
    },
    responses: {
      '200': 'Curation schedule updated successfully',
      '400': 'Invalid position',
      '404': 'Curation schedule not found',
      '409': 'Position conflict',
      '500': 'Failed to update curation schedule'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/admin/curations/schedules/:id',
    description: 'Delete curation schedule',
    category: 'ADMIN',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'number (required) - Schedule ID'
      }
    },
    responses: {
      '204': 'Curation schedule deleted successfully',
      '404': 'Curation schedule not found',
      '500': 'Failed to delete curation schedule'
    }
  },

  // Curation Media
  {
    method: 'POST',
    path: '/v2/admin/curations/:id/thumbnail',
    description: 'Upload level thumbnail for curation',
    category: 'MEDIA',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'number (required) - Curation ID'
      },
      body: {
        thumbnail: 'file (required) - Thumbnail image file'
      }
    },
    responses: {
      '200': 'Thumbnail uploaded successfully',
      '400': 'No thumbnail file uploaded',
      '404': 'Curation not found',
      '500': 'Failed to upload thumbnail'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/admin/curations/:id/thumbnail',
    description: 'Delete level thumbnail for curation',
    category: 'ADMIN',
    requiresAuth: true,
    parameters: {
      path: {
        id: 'number (required) - Curation ID'
      }
    },
    responses: {
      '200': 'Thumbnail removed successfully',
      '404': 'Curation not found',
      '500': 'Failed to delete thumbnail'
    }
  }
];

export default curationsEndpoints;
