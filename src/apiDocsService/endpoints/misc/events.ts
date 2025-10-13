import { EndpointDefinition } from '../../services/DocumentationService.js';

export const eventsEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/events',
    category: 'UTILS',
    description: 'Server-Sent Events (SSE) endpoint for real-time updates',
    parameters: {
      query: {
        userId: 'string (optional) - User ID for filtering events',
        source: 'string (optional) - Event source identifier',
        isManager: 'string (optional) - Whether user is a manager'
      }
    },
    responses: {
      '200': 'SSE stream with real-time event updates',
      '204': 'Preflight OPTIONS request response'
    },
    requiresAuth: false
  }
];
