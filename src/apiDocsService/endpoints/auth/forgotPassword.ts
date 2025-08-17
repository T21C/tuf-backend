import { EndpointDefinition } from '../../services/DocumentationService.js';

const forgotPasswordEndpoints: EndpointDefinition[] = [
  {
    method: 'POST',
    path: '/v2/auth/forgot-password/request',
    description: 'Request password reset email',
    category: 'AUTH',
    requiresAuth: false,
    parameters: {
      body: {
        email: 'string (required) - User email address',
        captchaToken: 'string (optional) - reCAPTCHA token for rate limiting'
      }
    },
    responses: {
      '200': 'Password reset email sent (if account exists)',
      '400': 'Invalid email format or missing captcha token',
      '429': 'Rate limit exceeded - Too many requests',
      '500': 'Failed to send password reset email'
    }
  },
  {
    method: 'POST',
    path: '/v2/auth/forgot-password/reset',
    description: 'Reset password with token',
    category: 'AUTH',
    requiresAuth: false,
    parameters: {
      body: {
        token: 'string (required) - Password reset token from email',
        password: 'string (required) - New password (minimum 8 characters)'
      }
    },
    responses: {
      '200': 'Password reset successfully',
      '400': 'Invalid or expired token, or password too short',
      '500': 'Failed to reset password'
    }
  }
];

export default forgotPasswordEndpoints;
