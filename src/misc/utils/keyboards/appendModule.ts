import {createProfileModuleId} from '@/misc/utils/profileModules/schema.js';
import {readStoredProfileModules, resolveLayout} from '@/misc/utils/profileModules/schema.js';
import type {ProfileModulesDocument} from '@/misc/utils/profileModules/schema.js';
import {profileModulesCap} from '@/misc/utils/profileModules/catalog.js';

export function layoutHasKeyboardsModule(document: ProfileModulesDocument | null | undefined): boolean {
  return Boolean(document?.modules.some((mod) => mod.type === 'keyboards'));
}

export function appendKeyboardsModule(
  stored: unknown,
  stellarActive: boolean,
): {document: ProfileModulesDocument; appended: boolean; skippedReason?: string} {
  const kind = 'player' as const;
  const current = stored
    ? {
        version: 1 as const,
        modules: resolveLayout(readStoredProfileModules(stored), kind),
      }
    : {
        version: 1 as const,
        modules: resolveLayout(null, kind),
      };
  if (layoutHasKeyboardsModule(current)) {
    return {document: current, appended: false, skippedReason: 'already-enabled'};
  }
  const cap = profileModulesCap(stellarActive);
  if (current.modules.length >= cap) {
    return {document: current, appended: false, skippedReason: 'cap'};
  }
  return {
    document: {
      version: 1,
      modules: [
        ...current.modules,
        {id: createProfileModuleId(), type: 'keyboards', config: {}},
      ],
    },
    appended: true,
  };
}
