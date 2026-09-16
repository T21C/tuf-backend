import { createHash, timingSafeEqual } from 'node:crypto';

export interface InternalTokens {
  incoming: string;
  outgoing: string;
}

export function readInternalTokens(env: NodeJS.ProcessEnv = process.env): InternalTokens | null {
  const incoming = env.AUTO_SUBMISSION_TO_TUF_TOKEN ?? '';
  const outgoing = env.TUF_TO_AUTO_SUBMISSION_TOKEN ?? '';
  const valid = (value: string) => /^[\x21-\x7e]{32,512}$/.test(value);
  if (!valid(incoming) || !valid(outgoing) || matchesToken(incoming, outgoing)) {
    return null;
  }
  return { incoming, outgoing };
}

export function acceptsInternalToken(authorization: string | undefined, tokens: InternalTokens): boolean {
  if (!authorization?.startsWith('Bearer ') || authorization.length > 519) {
    return false;
  }
  return matchesToken(authorization.slice(7), tokens.incoming);
}

function matchesToken(left: string, right: string): boolean {
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(left), hash(right));
}
