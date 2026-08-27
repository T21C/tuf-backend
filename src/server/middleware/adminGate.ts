/**
 * Default-deny authentication gate for the /v2/admin mount.
 *
 * Historically every admin route declared its own Auth.* guard, so forgetting
 * one silently published it (unauthenticated writes to submission creator
 * requests, staff listings exposing account-deletion schedules). This gate
 * inverts that: a route under /v2/admin is unreachable anonymously unless it is
 * listed below. Per-route guards still decide the privilege level — this only
 * removes "reachable by omission" as a failure mode.
 *
 * Paths are matched relative to the admin mount, so `/v2/admin/users/raters`
 * arrives here as `/users/raters`.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Auth } from '@/server/middleware/auth.js';

/**
 * Reads that are intentionally anonymous, each with a live public consumer.
 * Additions here need a matching consumer and must never expose data beyond
 * what that consumer renders.
 */
const PUBLIC_ADMIN_READS: readonly RegExp[] = [
  // About Us page credits (client/src/pages/misc/AboutUsPage).
  /^\/users\/raters$/,
  // Hyonsu bot role lookup; pending inbound service auth.
  /^\/users\/check\/[^/]+$/,
  // Curation data rendered for anonymous visitors: DifficultyContext pulls
  // /types, useWeeklyCurations pulls /schedules, CurationPreviewPage pulls /:id.
  /^\/curations$/,
  /^\/curations\/types$/,
  /^\/curations\/schedules$/,
  /^\/curations\/\d+$/,
  // Rating page (client/src/pages/admin/RatingPage) is public: it lists pending
  // ratings and pulls rater activity for its ornaments and Top raters popup.
  /^\/rating$/,
  // Deep-link / share open of a pending rating by level id.
  /^\/rating\/by-level\/\d+$/,
  // Zen Mode deal (client/src/pages/admin/RatingZenPage): GET with query filters;
  // still needs a logged-in user for myRated hide/only (Auth on the route).
  /^\/rating\/zen\/deal$/,
  /^\/statistics\/ratings-per-user$/,
];

/** True when an anonymous caller may reach this admin route. */
export function isPublicAdminRead(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if (verb !== 'GET' && verb !== 'HEAD') return false;

  const withoutQuery = path.split('?')[0];
  const normalized =
    withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, '') : withoutQuery;

  return PUBLIC_ADMIN_READS.some(pattern => pattern.test(normalized));
}

/** Require an authenticated session for every admin route bar the public reads. */
export const requireAdminAuth: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (isPublicAdminRead(req.method, req.path)) {
    next();
    return;
  }
  void Auth.user()(req, res, next);
};
