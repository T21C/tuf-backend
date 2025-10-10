import { EndpointDefinition } from '../../services/DocumentationService.js';

const auditLogEndpoints: EndpointDefinition[] = [
  {
    method: 'GET',
    path: '/v2/admin/audit-log',
    description: 'Get audit logs with filtering, searching, and pagination',
    category: 'ADMIN',
    requiresAuth: true,
    requiresAdmin: true,
    parameters: {
      query: {
        userId: 'string (optional) - Filter by user ID',
        action: 'string (optional) - Filter by action type',
        method: 'string (optional) - Filter by HTTP method',
        route: 'string (optional) - Filter by route (partial match)',
        startDate: 'string (optional) - Filter logs from this date',
        endDate: 'string (optional) - Filter logs until this date',
        q: 'string (optional) - Search in payload, result, action, and route',
        page: 'number (optional, default: 1) - Page number',
        pageSize: 'number (optional, default: 25) - Results per page',
        sort: 'string (optional, default: createdAt) - Sort field',
        order: 'string (optional, default: DESC) - Sort order (ASC, DESC)'
      }
    },
    responses: {
      '200': 'Paginated list of audit logs with user information',
      '401': 'Unauthorized',
      '403': 'Forbidden - requires super admin with password',
      '500': 'Failed to fetch audit logs'
    }
  }
];

export default auditLogEndpoints;
