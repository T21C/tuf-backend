import { EndpointDefinition } from '../../services/DocumentationService.js';

export const discordEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/discord/users/:userId',
    category: 'UTILS',
    description: 'Get Discord user information by user ID',
    parameters: {
      path: {
        userId: 'string (required) - Discord user ID (numeric)'
      }
    },
    responses: {
      '200': 'Discord user information with username and avatar',
      '400': 'Invalid Discord user ID format',
      '500': 'Server error fetching Discord user info'
    },
    requiresAuth: false
  }
];
