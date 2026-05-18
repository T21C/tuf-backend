import type {UserAttributes} from '@/models/auth/User.js';

declare global {
  namespace Express {
    interface Request {
      user?: UserAttributes
    }

    interface User extends UserAttributes {
      provider?: string;
      providerId?: string;
    }
  }
}
