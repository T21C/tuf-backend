import { EndpointDefinition } from '../../services/DocumentationService.js';

const registerEndpoints: EndpointDefinition[] = [
  {
    method: 'POST',
    path: '/v2/auth/register',
    description: 'Register a new user account',
    category: 'AUTH',
    requiresAuth: false,
    parameters: {
      body: {
        username: 'string (required) - Unique username',
        email: 'string (required) - Valid email address',
        password: 'string (required) - Password (min 8 characters)',
        confirmPassword: 'string (required) - Password confirmation'
      }
    },
    responses: {
      '201': 'Registration successful - Returns user data',
      '400': 'Validation error - Invalid input data',
      '409': 'User already exists - Email or username taken'
    }
  }
];

export default registerEndpoints; 