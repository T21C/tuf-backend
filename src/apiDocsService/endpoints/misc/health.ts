import { EndpointDefinition } from '../../services/DocumentationService.js';

export const healthEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/health',
    category: 'UTILS',
    description: 'Health check endpoint for system status monitoring',
    parameters: {},
    responses: {
      '200': 'System health status with database and socket server status',
      '500': 'Health check failed'
    },
    requiresAuth: false
  }
];
