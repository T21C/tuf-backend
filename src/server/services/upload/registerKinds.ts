import { registerUploadKind, startUploadSessionReaper } from '@/server/services/upload/UploadSessionService.js';
import { LevelZipUploadKind } from '@/server/services/upload/kinds/levelZip.js';
import { logger } from '@/server/services/core/LoggerService.js';

let initialised = false;

/**
 * Register all known upload kinds and start the TTL reaper.
 * Called once at boot via bootstrap/runtimeServices.
 */
export function initUploadKinds(): void {
  if (initialised) return;
  initialised = true;
  registerUploadKind(LevelZipUploadKind);
  startUploadSessionReaper();
  logger.debug('Upload kinds initialised: level-zip');
}
