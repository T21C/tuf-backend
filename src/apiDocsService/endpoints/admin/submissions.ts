import { EndpointDefinition } from '../../services/DocumentationService.js';

const submissionsEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/v2/admin/submissions/levels',
    description: 'Get all level submissions',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    responses: {
      '200': 'List of level submissions',
      '500': 'Failed to fetch level submissions'
    }
  },
  {
    method: 'GET',
    path: '/v2/admin/submissions/levels/pending',
    description: 'Get pending level submissions',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    responses: {
      '200': 'List of pending level submissions',
      '500': 'Failed to fetch pending level submissions'
    }
  },
  {
    method: 'GET',
    path: '/v2/admin/submissions/passes',
    description: 'Get all pass submissions',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    responses: {
      '200': 'List of pass submissions',
      '500': 'Failed to fetch pass submissions'
    }
  }
];

export default submissionsEndpoints;
