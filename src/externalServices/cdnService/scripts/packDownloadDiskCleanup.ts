/**
 * Manual ops — free disk on CDN pack volume before large downloads.
 *
 * Usage:
 *   npx tsx src/externalServices/cdnService/scripts/packDownloadDiskCleanup.ts [--dry-run]
 *
 * On production (example from logs):
 *   df -h "$CDN_TEMP_ROOT"
 *   npx tsx src/externalServices/cdnService/scripts/packDownloadDiskCleanup.ts
 *
 * Removes:
 *   - `<PACK_CDN_ROOT>/pack-downloads/temp/*` workspace dirs older than 2h
 *   - stale `<PACK_CDN_ROOT>/pack-downloads/*.zip` not yet uploaded / left after failures
 */
import dotenv from 'dotenv';
import path from 'path';
import { CDN_CONFIG } from '../config.js';
import {
    PACK_DOWNLOAD_TEMP_SWEEP_MAX_AGE_MS,
} from '../domain/pack/packDownloadConfig.js';
import { getVolumeFreeBytes } from '../domain/pack/packDownloadDisk.js';
import { sweepOrphanedPackDownloadArtifacts } from '../domain/pack/packDownloadTempSweep.js';

dotenv.config();

const packDownloadDir = path.join(CDN_CONFIG.pack_root, 'pack-downloads');
const tempDir = path.join(packDownloadDir, 'temp');
const dryRun = process.argv.includes('--dry-run');

async function main(): Promise<void> {
    const freeBefore = await getVolumeFreeBytes(packDownloadDir);
    console.log(`Pack download dir: ${packDownloadDir}`);
    console.log(`Temp dir: ${tempDir}`);
    if (freeBefore !== null) {
        console.log(`Free space: ~${(freeBefore / (1024 ** 3)).toFixed(2)} GiB`);
    } else {
        console.log('Free space: (statfs unavailable on this platform)');
    }

    if (dryRun) {
        console.log('Dry run — no files removed. Re-run without --dry-run to sweep.');
        return;
    }

    const result = await sweepOrphanedPackDownloadArtifacts(
        packDownloadDir,
        tempDir,
        PACK_DOWNLOAD_TEMP_SWEEP_MAX_AGE_MS,
    );
    const freeAfter = await getVolumeFreeBytes(packDownloadDir);

    console.log('Sweep complete:', result);
    if (freeAfter !== null) {
        console.log(`Free space after: ~${(freeAfter / (1024 ** 3)).toFixed(2)} GiB`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
