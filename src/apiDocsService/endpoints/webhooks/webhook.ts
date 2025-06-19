import { EndpointDefinition } from '../../services/DocumentationService.js';

const webhookEndpoints: EndpointDefinition[] = [
  {
    method: 'POST',
    path: '/v2/webhook/passes',
    description: 'Send pass announcement webhooks to configured Discord channels',
    category: 'UTILS',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      body: {
        passIds: 'number[] (required) - Array of pass IDs to announce'
      }
    },
    responses: {
      '200': 'Webhooks sent successfully',
      '400': 'Invalid input: passIds must be an array',
      '401': 'Authentication required',
      '403': 'Admin privileges required',
      '500': 'Failed to send webhook'
    }
  },
  {
    method: 'POST',
    path: '/v2/webhook/levels',
    description: 'Send level announcement webhooks to configured Discord channels',
    category: 'UTILS',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      body: {
        levelIds: 'number[] (required) - Array of level IDs to announce'
      }
    },
    responses: {
      '200': 'Webhooks sent successfully',
      '400': 'Invalid input: levelIds must be an array',
      '401': 'Authentication required',
      '403': 'Admin privileges required',
      '500': 'Failed to send webhook'
    }
  },
  {
    method: 'POST',
    path: '/v2/webhook/rerates',
    description: 'Send level rerate announcement webhooks to Discord',
    category: 'UTILS',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      body: {
        levelIds: 'number[] (required) - Array of level IDs that have been rerated'
      }
    },
    responses: {
      '200': 'Webhooks sent successfully',
      '400': 'Invalid input: levelIds must be an array',
      '401': 'Authentication required',
      '403': 'Admin privileges required',
      '500': 'Failed to send webhook'
    }
  }
];

export default webhookEndpoints; 