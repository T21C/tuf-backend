import type { RequestHandler } from 'express';
import { acceptsInternalToken, readInternalTokens } from './internalTokens.js';

export const requireSubmissionService: RequestHandler = (req, res, next) => {
  const tokens = readInternalTokens();
  if (!tokens || !acceptsInternalToken(req.get('authorization'), tokens)) {
    res.status(401).json({ error: 'Submission service authentication required' });
    return;
  }
  next();
};
