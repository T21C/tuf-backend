import { EndpointDefinition } from '../../services/DocumentationService.js';

const artistsEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/v2/database/artists',
    description: 'Get public artist list (paginated, searchable)',
    category: 'DATABASE',
    requiresAuth: false,
    parameters: {
      query: {
        page: 'string (optional) - Page number (default: "1")',
        limit: 'string (optional) - Items per page (default: "50", max: 200)',
        search: 'string (optional) - Search term (searches name and aliases)',
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
    description: 'Get public artist detail page with aliases, links, evidences, and song credits',
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
    method: 'GET',
    path: '/v2/database/artists/:id/evidences',
    description: 'Get evidence images for an artist (public read-only)',
    category: 'DATABASE',
    requiresAuth: false,
    parameters: {
      path: {
        id: 'integer (required) - Artist ID'
      }
    },
    responses: {
      '200': 'Returns array of evidence objects with id and link',
      '404': 'Artist not found',
      '500': 'Failed to fetch evidence'
    }
  }
];

export default artistsEndpoints;
