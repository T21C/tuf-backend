import { EndpointDefinition } from '../../services/DocumentationService.js';

const songsEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/v2/database/songs',
    description: 'Get public song list (paginated, searchable, filterable by artist)',
    category: 'DATABASE',
    requiresAuth: false,
    parameters: {
      query: {
        page: 'string (optional) - Page number (default: "1")',
        limit: 'string (optional) - Items per page (default: "50", max: 200)',
        search: 'string (optional) - Search term (searches name and aliases)',
        artistId: 'string (optional) - Filter by artist ID(s), supports comma-separated IDs like "51,76"',
        sort: 'string (optional) - Sort order: NAME_ASC, NAME_DESC, ID_ASC, ID_DESC (default: NAME_ASC)'
      }
    },
    responses: {
      '200': 'Returns { songs: array, total: number, page: number, limit: number, hasMore: boolean }',
      '500': 'Failed to fetch songs'
    }
  },
  {
    method: 'GET',
    path: '/v2/database/songs/:id',
    description: 'Get public song detail page with aliases, links, evidences, credits, and artists',
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
    method: 'GET',
    path: '/v2/database/songs/:id/evidences',
    description: 'Get evidence images for a song (public read-only)',
    category: 'DATABASE',
    requiresAuth: false,
    parameters: {
      path: {
        id: 'integer (required) - Song ID'
      }
    },
    responses: {
      '200': 'Returns array of evidence objects with id and link',
      '404': 'Song not found',
      '500': 'Failed to fetch evidence'
    }
  }
];

export default songsEndpoints;
