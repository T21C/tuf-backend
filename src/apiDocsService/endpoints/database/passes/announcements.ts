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
  },
  {
    path: '/v2/database/passes/markAnnounced',
    method: 'POST',
    category: 'PASSES',
    description: 'Mark multiple passes as announced',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      body: {
        passIds: 'Array of pass IDs to mark as announced'
      }
    },
    responses: {
      '200': 'Success message with count of marked passes',
      '400': 'Invalid passIds array',
      '500': 'Failed to mark passes as announced'
    }
  },
  {
    path: '/v2/database/passes/markAnnounced/:id',
    method: 'POST',
    category: 'PASSES',
    description: 'Mark a single pass as announced',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      path: {
        id: 'Pass ID (number)'
      }
    },
    responses: {
      '200': 'Success confirmation',
      '400': 'Invalid pass ID',
      '404': 'Pass not found',
      '500': 'Failed to mark pass as announced'
    }
  }
];

export default announcementsEndpoints; 