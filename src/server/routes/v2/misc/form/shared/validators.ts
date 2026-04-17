/**
 * Structural validators for nested JSON payloads on the level-submission body.
 * Pure functions; use alongside {@link sanitizeTextInput} after validation passes.
 */

export interface CreatorRequestLike {
  creatorName: string;
  role: string;
  creatorId?: number | null;
  isNewRequest?: boolean;
}

export interface TeamRequestLike {
  teamName: string;
  teamId?: number | null;
  isNewRequest?: boolean;
}

export function validateCreatorRequest(request: unknown): request is CreatorRequestLike {
  const r = request as Partial<CreatorRequestLike> | null | undefined;
  return Boolean(
    r &&
    typeof r.creatorName === 'string' &&
    r.creatorName.trim().length > 0 &&
    typeof r.role === 'string' &&
    r.role.trim().length > 0,
  );
}

export function validateTeamRequest(request: unknown): request is TeamRequestLike {
  const r = request as Partial<TeamRequestLike> | null | undefined;
  return Boolean(
    r &&
    typeof r.teamName === 'string' &&
    r.teamName.trim().length > 0,
  );
}
