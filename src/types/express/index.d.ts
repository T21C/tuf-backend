export interface IUser {
  username: string;
  access_token: string;
  isSuperAdmin?: boolean;
  roles?: string[];
  // Add any other user properties from your auth system
}

declare global {
  namespace Express {
    interface Request {
      user?: IUser;
    }
  }
} 