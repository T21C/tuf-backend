import { EndpointDefinition } from '../../services/DocumentationService.js';

const artistsEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/v2/database/artists',
    description: 'Get artist list (paginated, searchable, filterable by verification state)',
    category: 'DATABASE',
    requiresAuth: false,
    parameters: {
      query: {
        page: 'string (optional) - Page number (default: "1")',
        limit: 'string (optional) - Items per page (default: "50", max: 200)',
        search: 'string (optional) - Search term (searches name)',
        verificationState: 'string (optional) - Filter by verification state',
        sort: 'string (optional) - Sort order: NAME_ASC, NAME_DESC, ID_ASC, ID_DESC (default: NAME_ASC)'
      }
    },
    responses: {
      '200': 'Returns { artists: array, total: number, page: number, limit: number, hasMore: boolean }',
      '500': 'Failed to fetch artists'
    }
  },
  {
    method: 'GET',
    path: '/v2/database/artists/:id',
    description: 'Get artist detail page with aliases, links, evidences, and song credits',
    category: 'DATABASE',
    requiresAuth: false,
    parameters: {
      path: {
        id: 'integer (required) - Artist ID'
      }
    },
    responses: {
      '200': 'Returns artist object with aliases, links, evidences, and songCredits',
      '404': 'Artist not found',
      '500': 'Failed to fetch artist'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/artists',
    description: 'Create new artist with optional avatar upload',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      body: {
        name: 'string (required) - Artist name',
        verificationState: 'string (optional) - Verification state (default: "unverified")',
        aliases: 'array (optional) - Artist aliases (can be JSON string from FormData)',
        avatar: 'file (optional) - Avatar image file'
      }
    },
    responses: {
      '200': 'Returns created artist object with aliases, links, and evidences',
      '400': 'Name is required or duplicate artist name exists',
      '500': 'Failed to create artist'
    }
  },
  {
    method: 'PUT',
    path: '/v2/database/artists/:id',
    description: 'Update artist information (avatar must be updated via separate endpoint)',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Artist ID'
      },
      body: {
        name: 'string (optional) - Artist name',
        verificationState: 'string (optional) - Verification state',
        extraInfo: 'string (optional) - Extra information'
      }
    },
    responses: {
      '200': 'Returns updated artist object',
      '404': 'Artist not found',
      '500': 'Failed to update artist'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/artists/:id/avatar',
    description: 'Upload avatar image to CDN for artist',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Artist ID'
      },
      body: {
        avatar: 'file (required) - Avatar image file'
      }
    },
    responses: {
      '200': 'Returns { avatarUrl: string }',
      '400': 'No file uploaded or validation error',
      '500': 'Failed to upload avatar'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/database/artists/:id/avatar',
    description: 'Delete avatar image from CDN for artist',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Artist ID'
      }
    },
    responses: {
      '200': 'Returns { success: true }',
      '500': 'Failed to delete avatar'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/database/artists/:id',
    description: 'Delete artist (with checks for levels using it through song credits)',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Artist ID'
      }
    },
    responses: {
      '200': 'Returns { success: true }',
      '400': 'Cannot delete artist: used in level(s) through song credits',
      '404': 'Artist not found',
      '500': 'Failed to delete artist'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/artists/:id/merge',
    description: 'Merge artist into another artist',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Source artist ID'
      },
      body: {
        targetId: 'integer (required) - Target artist ID to merge into'
      }
    },
    responses: {
      '200': 'Returns { success: true }',
      '400': 'Target ID is required',
      '500': 'Failed to merge artists'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/artists/:id/split/check',
    description: 'Check if artists exist before splitting (validates names)',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Artist ID'
      },
      body: {
        name1: 'string (required) - First artist name',
        name2: 'string (required) - Second artist name'
      }
    },
    responses: {
      '200': 'Returns { existing1: object|null, existing2: object|null }',
      '400': 'name1 and name2 are required',
      '500': 'Failed to check existing artists'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/artists/:id/split',
    description: 'Split artist into two new artists',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Artist ID to split'
      },
      body: {
        name1: 'string (required) - First artist name',
        name2: 'string (required) - Second artist name',
        deleteOriginal: 'boolean (optional) - Delete original artist after split (default: false)',
        useExisting1: 'boolean (optional) - Use existing artist for name1 if found (default: false)',
        useExisting2: 'boolean (optional) - Use existing artist for name2 if found (default: false)'
      }
    },
    responses: {
      '200': 'Returns { success: true, artist1: object, artist2: object }',
      '400': 'name1 and name2 are required',
      '500': 'Failed to split artist'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/artists/:id/aliases',
    description: 'Add alias to artist',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Artist ID'
      },
      body: {
        alias: 'string (required) - Alias text'
      }
    },
    responses: {
      '200': 'Returns created alias object',
      '400': 'Alias is required',
      '500': 'Failed to add alias'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/database/artists/:id/aliases/:aliasId',
    description: 'Delete alias from artist',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Artist ID',
        aliasId: 'integer (required) - Alias ID'
      }
    },
    responses: {
      '200': 'Returns { success: true }',
      '404': 'Alias not found',
      '500': 'Failed to delete alias'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/artists/:id/links',
    description: 'Add link to artist',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Artist ID'
      },
      body: {
        link: 'string (required) - Link URL'
      }
    },
    responses: {
      '200': 'Returns created link object',
      '400': 'Link is required',
      '500': 'Failed to add link'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/database/artists/:id/links/:linkId',
    description: 'Delete link from artist',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Artist ID',
        linkId: 'integer (required) - Link ID'
      }
    },
    responses: {
      '200': 'Returns { success: true }',
      '404': 'Link not found',
      '500': 'Failed to delete link'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/artists/:id/evidences',
    description: 'Add evidence link to artist',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Artist ID'
      },
      body: {
        link: 'string (required) - Evidence link URL'
      }
    },
    responses: {
      '200': 'Returns created evidence object',
      '400': 'Link is required',
      '500': 'Failed to add evidence'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/artists/:id/evidences/upload',
    description: 'Upload evidence images to artist (up to 10 files)',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Artist ID'
      },
      body: {
        evidence: 'file[] (required) - Evidence image files (max 10)'
      }
    },
    responses: {
      '200': 'Returns { evidences: array }',
      '400': 'No files uploaded or validation error',
      '500': 'Failed to upload evidence'
    }
  },
  {
    method: 'PUT',
    path: '/v2/database/artists/:id/evidences/:evidenceId',
    description: 'Update evidence link (only for external links, not CDN-managed)',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Artist ID',
        evidenceId: 'integer (required) - Evidence ID'
      },
      body: {
        link: 'string (required) - Updated evidence link URL'
      }
    },
    responses: {
      '200': 'Returns updated evidence object',
      '400': 'Link is required or cannot update CDN-managed evidence',
      '500': 'Failed to update evidence'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/database/artists/:id/evidences/:evidenceId',
    description: 'Delete evidence from artist',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Artist ID',
        evidenceId: 'integer (required) - Evidence ID'
      }
    },
    responses: {
      '200': 'Returns { success: true }',
      '500': 'Failed to delete evidence'
    }
  },
  {
    method: 'GET',
    path: '/v2/database/artists/:id/evidences',
    description: 'Get all evidence for an artist',
    category: 'DATABASE',
    requiresAuth: false,
    parameters: {
      path: {
        id: 'integer (required) - Artist ID'
      }
    },
    responses: {
      '200': 'Returns array of evidence objects',
      '500': 'Failed to fetch evidence'
    }
  }
];

export default artistsEndpoints;
