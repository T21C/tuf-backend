import {readStoredProfileModules} from '@/misc/utils/profileModules/schema.js';

export function playerHasKeyboardsModule(payload: unknown): boolean {
  const stored = readStoredProfileModules(payload);
  if (!stored) return false;
  return stored.modules.some((mod) => mod.type === 'keyboards');
}
