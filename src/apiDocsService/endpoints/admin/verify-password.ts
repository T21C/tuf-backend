import { EndpointDefinition } from '../../services/DocumentationService.js';

const verifyPasswordEndpoints: EndpointDefinition[] = [
  {
    method: 'HEAD',
    path: '/v2/admin/verify-password',
    description: 'Verify super admin password',
    category: 'ADMIN',
    requiresAuth: true,
    parameters: {
      headers: {
        'X-Super-Admin-Password': 'string (required) - Super admin password'
      }
    },
    responses: {
      '200': 'Password is valid',
      '401': 'Invalid password'
    }
  }
];

export default verifyPasswordEndpoints;
