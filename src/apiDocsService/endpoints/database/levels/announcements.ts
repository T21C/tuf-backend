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
  }
];

export default announcementsEndpoints; 