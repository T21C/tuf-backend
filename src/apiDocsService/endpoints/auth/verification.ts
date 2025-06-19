import { EndpointDefinition } from '../../services/DocumentationService.js';

const verificationEndpoints: EndpointDefinition[] = [
  {
    method: 'POST',
    path: '/v2/auth/verify-email',
    description: 'Verify user email address',
    category: 'AUTH',
    requiresAuth: false,
    parameters: {
      body: {
        token: 'string (required) - Email verification token',
        email: 'string (required) - User email address'
      }
    },
    responses: {
      '200': 'Email verified successfully',
      '400': 'Invalid or expired token',
      '404': 'User not found'
    }
  },
  {
    method: 'POST',
    path: '/v2/auth/resend-verification',
    description: 'Resend email verification',
    category: 'AUTH',
    requiresAuth: false,
    parameters: {
      body: {
        email: 'string (required) - User email address'
      }
    },
    responses: {
      '200': 'Verification email sent successfully',
      '400': 'Invalid email address',
      '404': 'User not found'
    }
  }
];

export default verificationEndpoints; 