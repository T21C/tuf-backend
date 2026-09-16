import type { Request } from 'express';
import { gateSubmissionUser } from '@/server/services/submissions/submissionPermission.js';

export { gateSubmissionUser };

export function gateSubmission(req: Request): { userId: string } {
  return gateSubmissionUser(req.user);
}
