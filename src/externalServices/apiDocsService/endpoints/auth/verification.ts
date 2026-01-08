import { EndpointDefinition } from '../../services/DocumentationService.js';

const verificationEndpoints: EndpointDefinition[] = [
  {
    method: 'POST',
    path: '/v2/auth/verify/email',
    description: 'Verify user email address',
    category: 'AUTH',
    requiresAuth: false,
    parameters: {
      body: {
        token: 'string (required) - Email verification token'
      }
    },
    responses: {
      '200': 'Email verified successfully',
      '400': 'Invalid or expired token',
      '500': 'Email verification failed'
    }
  },
  {
    method: 'POST',
    path: '/v2/auth/verify/resend',
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
      '400': 'Email already verified or invalid email',
      '404': 'User not found',
      '429': 'Rate limit exceeded',
      '500': 'Failed to send verification email'
    }
  }
];

export default verificationEndpoints;
