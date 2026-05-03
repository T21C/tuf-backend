import path from 'path';
import { logger } from '@/server/services/core/LoggerService.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import { spacesStorage } from '../../../infra/storage/spacesStorage.js';
import { CdnSpacesTempDomain, withCdnFileDomainWorkspace } from '../../../infra/workspaces/cdnSpacesTemp.js';
import {
    listEntries as archiveListEntries,
    extractEntry as archiveExtractEntry
} from '../../../infra/archive/archiveService.js';
import { scanOversizedLevelFile } from './oversizedLevelScan.js';
import { resolveAudioRelativePath } from './oversizedSongPick.js';
import { readAudioDurationMs } from './audioDuration.js';
import { computeLevelCacheMetadataSignature } from '../levelCacheSignature.js';
import { LEVEL_SUPPORTED_AUDIO_EXTENSION_SET } from '../../../constants/levelPackAudio.js';
import type { OversizedMinimalCache, OversizedZipMetadata } from './levelCacheOversizedTypes.js';

export async function performOversizedCacheBackfill(params: {
    file: CdnFile;
    metadata: OversizedZipMetadata;
    targetLevel: string;
}): Promise<OversizedMinimalCache | null> {
    const { file, metadata, targetLevel } = params;

    const originalZipPath = metadata.originalZip?.path;
    if (!originalZipPath) {
        logger.warn('refreshCache (oversized backfill): no originalZip.path for oversized target', { fileId: file.id });
        return null;
    }

    return await withCdnFileDomainWorkspace(CdnSpacesTempDomain.LevelCache, file.id, async ({ join }) => {
        const tempZipPath = join(`original_${Date.now()}.zip`);
        await spacesStorage.downloadFileToPathStreaming(originalZipPath, tempZipPath);

        const entries = await archiveListEntries(tempZipPath);

        const wantedRel =
            (metadata.targetLevelRelativePath && String(metadata.targetLevelRelativePath)) ||
            (metadata.allLevelFiles || []).find(f => f.path === targetLevel)?.relativePath ||
            null;

        const wantedBase = wantedRel
            ? path.posix.basename(String(wantedRel).replace(/\\/g, '/'))
            : path.basename(targetLevel);

        const levelEntry =
            (wantedRel
                ? entries.find(e => !e.isDirectory && e.relativePath === String(wantedRel).replace(/\\/g, '/'))
                : null) ||
            entries.find(e => !e.isDirectory && (e.name === wantedBase || e.relativePath.endsWith(`/${wantedBase}`))) ||
            null;

        if (!levelEntry) {
            logger.warn('refreshCache (oversized backfill): cannot find target level entry in archive', {
                fileId: file.id,
                wantedRel,
                wantedBase
            });
            return null;
        }

        const extractedLevelPath = join(`oversized_${Date.now()}.adofai`);
        await archiveExtractEntry(tempZipPath, levelEntry, extractedLevelPath);

        const basics = await scanOversizedLevelFile(extractedLevelPath);

        // Resolve audio entry from archive entries (don’t trust songFilename encoding).
        const audioCandidates = entries
            .filter(e => !e.isDirectory && LEVEL_SUPPORTED_AUDIO_EXTENSION_SET.has(path.extname(e.relativePath).toLowerCase()))
            .map(e => ({ relativePath: e.relativePath }));

        const chosenAudioRel = resolveAudioRelativePath({
            candidates: audioCandidates,
            levelRelativePath: wantedRel ?? levelEntry.relativePath,
            settingsSongFilename: basics.settings.songFilename
        });

        let levelLengthInMs: number | null = null;
        if (chosenAudioRel) {
            const audioEntry = entries.find(e => !e.isDirectory && e.relativePath === chosenAudioRel) || null;
            if (audioEntry) {
                const extractedAudioPath = join(`audio_${Date.now()}${path.extname(audioEntry.relativePath)}`);
                await archiveExtractEntry(tempZipPath, audioEntry, extractedAudioPath);
                levelLengthInMs = await readAudioDurationMs(extractedAudioPath);
            }
        }

        const metaForSignature = file.metadata as any;
        const cacheData: OversizedMinimalCache = {
            _metadataSignature: computeLevelCacheMetadataSignature(metaForSignature),
            tilecount: basics.tilecount,
            settings: {
                bpm: basics.settings.bpm,
                offset: basics.settings.offset,
                songFilename: basics.settings.songFilename
            },
            analysis: levelLengthInMs !== null ? ({ levelLengthInMs } as any) : undefined,
            transformOptions: { eventTypes: [], filterTypes: [], advancedFilterTypes: [] }
        };

        await file.update({ cacheData: JSON.stringify(cacheData) });
        return cacheData;
    });
}
