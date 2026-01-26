import { EndpointDefinition } from '../../services/DocumentationService.js';

const songsEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/v2/database/songs',
    description: 'Get song list (paginated, searchable, filterable by artist and verification state)',
    category: 'DATABASE',
    requiresAuth: false,
    parameters: {
      query: {
        page: 'string (optional) - Page number (default: "1")',
        limit: 'string (optional) - Items per page (default: "50", max: 200)',
        search: 'string (optional) - Search term (searches name)',
        artistId: 'string (optional) - Filter by artist ID(s), supports comma-separated IDs like "51,76"',
        sort: 'string (optional) - Sort order: NAME_ASC, NAME_DESC, ID_ASC, ID_DESC (default: NAME_ASC)',
        verificationState: 'string (optional) - Filter by verification state'
      }
    },
    responses: {
      '200': 'Returns { songs: array, total: number, page: number, limit: number, hasMore: boolean }',
      '500': 'Failed to fetch songs'
    }
  },
  {
    method: 'GET',
    path: '/v2/database/songs/:id/levels/info',
    description: 'Get level information (count and suffix distribution) for a song',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Song ID'
      }
    },
    responses: {
      '200': 'Returns { levels: array, count: number }',
      '404': 'Song not found',
      '500': 'Failed to fetch level info'
    }
  },
  {
    method: 'GET',
    path: '/v2/database/songs/:id',
    description: 'Get song detail page with aliases, links, evidences, credits, and artists',
    category: 'DATABASE',
    requiresAuth: false,
    parameters: {
      path: {
        id: 'integer (required) - Song ID'
      }
    },
    responses: {
      '200': 'Returns song object with aliases, links, evidences, credits, artists, and levels',
      '404': 'Song not found',
      '500': 'Failed to fetch song'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/songs',
    description: 'Create new song',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      body: {
        name: 'string (required) - Song name',
        verificationState: 'string (optional) - Verification state (default: "pending")',
        aliases: 'array (optional) - Song aliases'
      }
    },
    responses: {
      '200': 'Returns created song object',
      '400': 'Name is required',
      '500': 'Failed to create song'
    }
  },
  {
    method: 'PUT',
    path: '/v2/database/songs/:id',
    description: 'Update song information',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Song ID'
      },
      body: {
        name: 'string (optional) - Song name',
        verificationState: 'string (optional) - Verification state',
        extraInfo: 'string (optional) - Extra information'
      }
    },
    responses: {
      '200': 'Returns updated song object',
      '404': 'Song not found',
      '500': 'Failed to update song'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/database/songs/:id',
    description: 'Delete song (with checks for levels using it)',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Song ID'
      }
    },
    responses: {
      '200': 'Returns { success: true }',
      '400': 'Cannot delete song: used in level(s)',
      '404': 'Song not found',
      '500': 'Failed to delete song'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/songs/:id/merge',
    description: 'Merge song into another song',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Source song ID'
      },
      body: {
        targetId: 'integer (required) - Target song ID to merge into'
      }
    },
    responses: {
      '200': 'Returns { success: true }',
      '400': 'Target ID is required',
      '500': 'Failed to merge songs'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/songs/:id/aliases',
    description: 'Add alias to song',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Song ID'
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
    path: '/v2/database/songs/:id/aliases/:aliasId',
    description: 'Delete alias from song',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Song ID',
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
    path: '/v2/database/songs/:id/links',
    description: 'Add link to song',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Song ID'
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
    path: '/v2/database/songs/:id/links/:linkId',
    description: 'Delete link from song',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Song ID',
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
    path: '/v2/database/songs/:id/evidences',
    description: 'Add evidence link to song',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Song ID'
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
    path: '/v2/database/songs/:id/evidences/upload',
    description: 'Upload evidence images to song (up to 10 files)',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Song ID'
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
    path: '/v2/database/songs/:id/evidences/:evidenceId',
    description: 'Update evidence link (only for external links, not CDN-managed)',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Song ID',
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
    path: '/v2/database/songs/:id/evidences/:evidenceId',
    description: 'Delete evidence from song',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Song ID',
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
    path: '/v2/database/songs/:id/evidences',
    description: 'Get all evidence for a song',
    category: 'DATABASE',
    requiresAuth: false,
    parameters: {
      path: {
        id: 'integer (required) - Song ID'
      }
    },
    responses: {
      '200': 'Returns array of evidence objects',
      '500': 'Failed to fetch evidence'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/songs/:id/credits',
    description: 'Add artist credit to song',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Song ID'
      },
      body: {
        artistId: 'integer (required) - Artist ID',
        role: 'string (optional) - Credit role'
      }
    },
    responses: {
      '200': 'Returns created credit object',
      '400': 'Artist ID is required',
      '500': 'Failed to add credit'
    }
  },
  {
    method: 'DELETE',
    path: '/v2/database/songs/:id/credits/:creditId',
    description: 'Remove artist credit from song',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Song ID',
        creditId: 'integer (required) - Credit ID'
      }
    },
    responses: {
      '200': 'Returns { success: true }',
      '404': 'Credit not found',
      '500': 'Failed to delete credit'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/songs/:id/levels/suffix',
    description: 'Bulk update suffix for all levels with this song',
    category: 'DATABASE',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Song ID'
      },
      body: {
        suffix: 'string (optional) - Suffix text (trimmed, null if empty)'
      }
    },
    responses: {
      '200': 'Returns { success: true, updatedCount: number }',
      '404': 'Song not found',
      '500': 'Failed to update level suffixes'
    }
  }
];

export default songsEndpoints;
