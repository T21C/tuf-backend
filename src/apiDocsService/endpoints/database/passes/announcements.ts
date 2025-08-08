import { EndpointDefinition } from '../../../services/DocumentationService.js';

const announcementsEndpoints: EndpointDefinition[] = [
  {
    path: '/v2/database/passes/unannounced/new',
    method: 'GET',
    category: 'PASSES',
    description: 'Get all unannounced passes for admin review',
    requiresAuth: true,
    requiresAdmin: true,
    responses: {
      '200': 'Array of unannounced pass objects with player, level, and judgement data',
      '500': 'Failed to fetch unannounced passes'
    }
  }
];

export default announcementsEndpoints; 