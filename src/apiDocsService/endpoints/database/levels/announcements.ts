import { EndpointDefinition } from '../../../services/DocumentationService.js';

const announcementsEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/v2/database/levels/unannounced/new',
    description: 'Get all levels that are new (not rerates) and have not been announced yet',
    category: 'LEVELS',
    requiresAuth: true,
    requiresAdmin: true,
    responses: {
      '200': 'List of unannounced new levels',
      '401': 'Unauthorized',
      '403': 'Forbidden - requires super admin',
      '500': 'Failed to fetch unannounced new levels'
    }
  },
  {
    method: 'GET',
    path: '/v2/database/levels/unannounced/rerates',
    description: 'Get all levels that are rerates and have not been announced yet',
    category: 'LEVELS',
    requiresAuth: true,
    requiresAdmin: true,
    responses: {
      '200': 'List of unannounced rerates',
      '401': 'Unauthorized',
      '403': 'Forbidden - requires super admin',
      '500': 'Failed to fetch unannounced rerates'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/levels/markAnnounced',
    description: 'Mark multiple levels as announced in a single operation',
    category: 'LEVELS',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      body: {
        levelIds: 'array of integers (required) - Array of level IDs to mark as announced'
      }
    },
    responses: {
      '200': 'Levels marked as announced successfully',
      '400': 'levelIds must be an array',
      '401': 'Unauthorized',
      '403': 'Forbidden - requires super admin',
      '500': 'Failed to mark levels as announced'
    }
  },
  {
    method: 'POST',
    path: '/v2/database/levels/markAnnounced/:id',
    description: 'Mark a single level as announced',
    category: 'LEVELS',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'integer (required) - Level ID'
      }
    },
    responses: {
      '200': 'Level marked as announced successfully',
      '400': 'Invalid level ID',
      '401': 'Unauthorized',
      '403': 'Forbidden - requires super admin',
      '404': 'Level not found',
      '500': 'Failed to mark level as announced'
    }
  }
];

export default announcementsEndpoints; 