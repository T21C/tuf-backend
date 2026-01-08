import type {UserAttributes} from '../../../models/auth/User.js';

declare global {
  namespace Express {
    interface Request {
      user?: UserAttributes & {
        provider?: string;
        providerId?: string;
      };
    }

    interface User extends UserAttributes {
      provider?: string;
      providerId?: string;
    }
  }
}
