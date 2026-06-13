#!/usr/bin/env npx tsx
/**
 * Re-ingest LEVELZIP rows listed in a **generated** `mojibake-hits.ndjson` (from
 * `auditLevelzipMojibakeMetadata.ts`) by resolving each `fileId` to a `levels` row, downloading
 * the current archive bytes, and running {@link finalizeLevelZipUploadFromBuffer} — the same
 * finalisation path as an admin zip upload (CDN async ingest + DB + chart sync).
 *
 * After each successful upload, verifies the **new** CDN `fileId` metadata with the shared
 * mojibake auditor; if hits remain, exits with failure and the hit line is **not** removed.
 *
 * On full success, the first NDJSON line is removed from the hits file (file rewritten) so runs
 * can resume after partial progress.
 *
 * Usage (from `server/`):
 *   Same as the audit script: with non-TTY stdout, Winston’s console transport is omitted when argv
 *   names this file (see LoggerService); use TUF_SUPPRESS_CONSOLE_LOGGER to force on/off.
 *   npx tsx src/externalServices/cdnService/scripts/migrateMojibakeLevelZipsFromHits.ts --dry-run
 *   npx tsx ... --apply --actor-user-id <uuid>   # users.id (UUID), must be SUPER_ADMIN
 *   npx tsx ... --hits-file ./mojibake-hits.ndjson
 *   npx tsx ... --apply --actor-user-id <uuid> --continue-on-error   # dequeue failed lines too
 *   npx tsx ... --apply --actor-user-id <uuid> --max-files 5         # migrate 5 successes then stop (queue tail unchanged)
 *   npx tsx ... --dry-run --max-files 10                        # preview only the first 10 would-migrate rows
 *
 * Pipeline verification (exit codes documented in audit script header):
 *   npx tsx src/externalServices/cdnService/scripts/auditLevelzipMojibakeMetadata.ts --file-id <newUuid> --check-clean
 */

import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import { Command } from 'commander';
import dotenv from 'dotenv';
import { Op } from 'sequelize';

dotenv.config();

import Level from '@/models/levels/Level.js';
import User from '@/models/auth/User.js';
import CdnFile from '@/models/cdn/CdnFile.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import { permissionFlags } from '@/config/constants.js';
import { normalizeLevelDlLinkSnapshot } from '@/server/domain/levels/levelDlLinkSnapshot.js';
import { encodeLevelZipFilenameForCdn } from '@/server/domain/levels/levelZipFilename.js';
import { finalizeLevelZipUploadFromBuffer } from '@/server/domain/levels/levelZipFinalize.js';
import cdnService from '@/server/services/core/CdnService.js';
import {
    auditLevelzipMetadataForMojibake,
    type MojibakeStringHit,
} from '../domain/metadata/mojibakeAuditLevelzipMetadata.js';

const CDN_ZIP_FILE_ID_PARAM = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** `users.id` is UUID (any variant); permissive hex pattern for CLI validation */
const USER_PK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type HitsNdjsonLine = { fileId?: string; hitCount?: number; hits?: unknown };

function parseHitsLine(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return null;
    let obj: HitsNdjsonLine;
    try {
        obj = JSON.parse(trimmed) as HitsNdjsonLine;
    } catch {
        return null;
    }
    const id = typeof obj.fileId === 'string' ? obj.fileId.trim() : '';
    if (!id || !CDN_ZIP_FILE_ID_PARAM.test(id)) return null;
    return id;
}

async function findLevelForCdnFileId(fileId: string): Promise<Level | null> {
    const byCol = await Level.findAll({
        where: { fileId, isDeleted: false },
        limit: 2,
    });
    if (byCol.length >= 1) {
        if (byCol.length > 1) {
            logger.warn('migrateMojibakeLevelZipsFromHits: multiple levels share fileId; using lowest id', {
                fileId,
                levelIds: byCol.map((l) => l.id),
            });
        }
        byCol.sort((a, b) => a.id - b.id);
        return byCol[0] ?? null;
    }
    return Level.findOne({
        where: {
            isDeleted: false,
            dlLink: { [Op.like]: `%/${fileId}` },
        },
    });
}

/**
 * Windows PowerShell `>` often writes **UTF-16 LE** (with BOM). Reading that as UTF-8 yields a
 * string with U+0000 between ASCII letters, so JSON.parse fails (`unparseable-line`).
 */
function decodeHitsFileBuffer(buf: Buffer): string {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        return buf.subarray(2).toString('utf16le');
    }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        return new TextDecoder('utf-16be').decode(buf.subarray(2));
    }
    // UTF-16 LE without BOM: first bytes of `{"` are 7B 00 22 00
    if (buf.length >= 4 && buf[0] === 0x7b && buf[1] === 0x00 && buf[2] === 0x22 && buf[3] === 0x00) {
        return buf.toString('utf16le');
    }
    const s = buf.toString('utf8');
    return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

async function readHitsLines(hitsFile: string): Promise<string[]> {
    const buf = await fs.promises.readFile(hitsFile);
    const raw = decodeHitsFileBuffer(buf);
    return raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
}

async function writeHitsLines(hitsFile: string, lines: string[]): Promise<void> {
    const body = lines.length > 0 ? `${lines.join('\n')}\n` : '';
    await fs.promises.writeFile(hitsFile, body, 'utf8');
}

async function verifyNewCdnMetadataClean(newFileId: string): Promise<MojibakeStringHit[]> {
    const row = await CdnFile.findOne({
        where: { id: newFileId, type: 'LEVELZIP' },
        attributes: ['metadata'],
    });
    if (!row) {
        throw new Error(`Post-migrate audit: no LEVELZIP cdn_files row for new fileId=${newFileId}`);
    }
    return auditLevelzipMetadataForMojibake(row.metadata);
}

async function main(): Promise<void> {
    const program = new Command();
    program
        .option('--hits-file <path>', 'NDJSON input (default: ./mojibake-hits.ndjson in cwd)', '')
        .option('--dry-run', 'Parse queue and print actions only (does not modify the hits file)', false)
        .option('--apply', 'Perform migrations (requires --actor-user-id)', false)
        .option(
            '--actor-user-id <uuid>',
            'users.id (UUID) for req.user when applying migrations (must be SUPER_ADMIN)',
            '',
        )
        .option(
            '--continue-on-error',
            'On failure: log error, remove the current line from the hits file, and continue (default: stop without removing the line)',
            false,
        )
        .option(
            '--max-files <n>',
            'Cap successful re-ingests (--apply) or would-migrate preview rows (--dry-run); omit = process entire queue',
            '',
        )
        .parse();

    const opts = program.opts<{
        hitsFile?: string;
        dryRun?: boolean;
        apply?: boolean;
        actorUserId?: string;
        continueOnError?: boolean;
        maxFiles?: string;
    }>();

    const dryRun = opts.dryRun === true;
    const apply = opts.apply === true;
    const continueOnError = opts.continueOnError === true;

    let maxFiles: number | null = null;
    const maxFilesRaw = String(opts.maxFiles ?? '').trim();
    if (maxFilesRaw !== '') {
        const n = parseInt(maxFilesRaw, 10);
        if (!Number.isFinite(n) || n < 1) {
            // eslint-disable-next-line no-console
            console.error('migrateMojibakeLevelZipsFromHits: --max-files must be a positive integer');
            process.exit(1);
        }
        maxFiles = n;
    }
    const hitsFile = path.resolve(
        process.cwd(),
        opts.hitsFile && String(opts.hitsFile).trim() !== '' ? String(opts.hitsFile) : 'mojibake-hits.ndjson',
    );

    if (apply && dryRun) {
        // eslint-disable-next-line no-console
        console.error('migrateMojibakeLevelZipsFromHits: use only one of --apply or --dry-run');
        process.exit(1);
    }
    if (!apply && !dryRun) {
        // eslint-disable-next-line no-console
        console.error('migrateMojibakeLevelZipsFromHits: specify --dry-run or --apply');
        process.exit(1);
    }
    let actor: User | null = null;
    if (apply) {
        const actorUserId = String(opts.actorUserId ?? '').trim();
        if (!actorUserId || !USER_PK_UUID.test(actorUserId)) {
            // eslint-disable-next-line no-console
            console.error('migrateMojibakeLevelZipsFromHits: --apply requires --actor-user-id <uuid> (users.id)');
            process.exit(1);
        }
        actor = await User.findByPk(actorUserId);
        if (!actor) {
            // eslint-disable-next-line no-console
            console.error(`migrateMojibakeLevelZipsFromHits: user id not found: ${actorUserId}`);
            process.exit(1);
        }
        if (!hasFlag(actor, permissionFlags.SUPER_ADMIN)) {
            // eslint-disable-next-line no-console
            console.error(
                `migrateMojibakeLevelZipsFromHits: user ${actorUserId} must have SUPER_ADMIN (duration / ingest safeguards)`,
            );
            process.exit(1);
        }
    }

    if (!fs.existsSync(hitsFile)) {
        // eslint-disable-next-line no-console
        console.error(`migrateMojibakeLevelZipsFromHits: hits file not found: ${hitsFile}`);
        process.exit(1);
    }

    const initialLines = await readHitsLines(hitsFile);
    if (initialLines.length === 0) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ ok: true, message: 'hits file empty', hitsFile }));
        return;
    }

    if (dryRun) {
        let wouldProcess = 0;
        let stoppedEarly = false;
        for (const line of initialLines) {
            if (maxFiles !== null && wouldProcess >= maxFiles) {
                stoppedEarly = true;
                break;
            }
            const fileId = parseHitsLine(line);
            if (!fileId) {
                // eslint-disable-next-line no-console
                console.log(
                    JSON.stringify({
                        dryRun: true,
                        skipped: 'unparseable-line',
                        preview: line.slice(0, 160),
                    }),
                );
                continue;
            }
            const level = await findLevelForCdnFileId(fileId);
            if (!level) {
                // eslint-disable-next-line no-console
                console.log(JSON.stringify({ dryRun: true, fileId, error: 'no_level_row' }));
                continue;
            }
            const cdnRow = await CdnFile.findOne({
                where: { id: fileId, type: 'LEVELZIP' },
                attributes: ['id'],
            });
            if (!cdnRow) {
                // eslint-disable-next-line no-console
                console.log(JSON.stringify({ dryRun: true, fileId, error: 'no_cdn_row' }));
                continue;
            }
            // eslint-disable-next-line no-console
            console.log(
                JSON.stringify({
                    dryRun: true,
                    fileId,
                    levelId: level.id,
                    wouldUseFilename: encodeLevelZipFilenameForCdn(level),
                }),
            );
            wouldProcess++;
        }
        // eslint-disable-next-line no-console
        console.log(
            JSON.stringify({
                ok: true,
                dryRun: true,
                hitsFile,
                totalLines: initialLines.length,
                wouldProcess,
                ...(maxFiles !== null ? { maxFiles, stoppedEarly } : {}),
            }),
        );
        return;
    }

    const reqUser = actor as User;
    let lines = [...initialLines];
    let processed = 0;
    let failed = 0;

    const dequeueFirstLine = async (): Promise<void> => {
        lines = lines.slice(1);
        await writeHitsLines(hitsFile, lines);
    };

    while (lines.length > 0) {
        if (maxFiles !== null && processed >= maxFiles) {
            // eslint-disable-next-line no-console
            console.error(
                JSON.stringify({
                    phase: 'batch-cap',
                    maxFiles,
                    processed,
                    remainingLinesInQueue: lines.length,
                }),
            );
            break;
        }

        const line = lines[0]!;
        const fileId = parseHitsLine(line);
        if (!fileId) {
            logger.warn('migrateMojibakeLevelZipsFromHits: removing unparseable line', {
                preview: line.slice(0, 120),
            });
            await dequeueFirstLine();
            continue;
        }

        const level = await findLevelForCdnFileId(fileId);
        if (!level) {
            const msg = `No level row for fileId=${fileId} (fileId column and dlLink suffix)`;
            // eslint-disable-next-line no-console
            console.error(msg);
            if (!continueOnError) {
                process.exit(1);
            }
            failed++;
            await dequeueFirstLine();
            continue;
        }

        const cdnRow = await CdnFile.findOne({
            where: { id: fileId, type: 'LEVELZIP' },
            attributes: ['id'],
        });
        if (!cdnRow) {
            const msg = `No LEVELZIP cdn_files row for fileId=${fileId}`;
            // eslint-disable-next-line no-console
            console.error(msg);
            if (!continueOnError) {
                process.exit(1);
            }
            failed++;
            await dequeueFirstLine();
            continue;
        }

        const encodedZipFileName = encodeLevelZipFilenameForCdn(level);
        const expectedDlLink = normalizeLevelDlLinkSnapshot(level.dlLink);

        // eslint-disable-next-line no-console
        console.error(
            JSON.stringify({
                phase: 'download',
                fileId,
                levelId: level.id,
                encodedZipFileName,
            }),
        );

        let zipBuffer: Buffer;
        try {
            zipBuffer = await cdnService.getFile(fileId);
        } catch (e) {
            const msg = `Failed to download zip for fileId=${fileId}: ${e instanceof Error ? e.message : String(e)}`;
            // eslint-disable-next-line no-console
            console.error(msg);
            if (!continueOnError) {
                process.exit(1);
            }
            failed++;
            await dequeueFirstLine();
            continue;
        }

        const beforeLevelId = level.id;
        const beforeFileId = fileId;

        try {
            await finalizeLevelZipUploadFromBuffer({
                req: { user: reqUser } as unknown as Request,
                res: null,
                levelId: level.id,
                expectedDlLink,
                fileBuffer: zipBuffer,
                encodedZipFileName,
                assembledFilePathToUnlink: null,
                uploadSession: null,
                canEdit: true,
                uploadJobId: null,
                uploadJobMeta: { source: 'mojibake_metadata_migrate', oldFileId: beforeFileId },
            });
        } catch (e) {
            const msg = `finalizeLevelZipUploadFromBuffer failed levelId=${beforeLevelId} fileId=${beforeFileId}: ${
                e instanceof Error ? e.message : String(e)
            }`;
            // eslint-disable-next-line no-console
            console.error(msg);
            if (!continueOnError) {
                process.exit(1);
            }
            failed++;
            await dequeueFirstLine();
            continue;
        }

        const after = await Level.findByPk(beforeLevelId, { attributes: ['id', 'fileId', 'dlLink'] });
        const newFileId = after?.fileId?.trim();
        if (!newFileId) {
            const msg = `Post-upload: level ${beforeLevelId} has no fileId`;
            // eslint-disable-next-line no-console
            console.error(msg);
            if (!continueOnError) {
                process.exit(1);
            }
            failed++;
            await dequeueFirstLine();
            continue;
        }

        let postHits: MojibakeStringHit[];
        try {
            postHits = await verifyNewCdnMetadataClean(newFileId);
        } catch (e) {
            const msg = `Post-migrate audit threw for newFileId=${newFileId}: ${
                e instanceof Error ? e.message : String(e)
            }`;
            // eslint-disable-next-line no-console
            console.error(msg);
            if (!continueOnError) {
                process.exit(1);
            }
            failed++;
            await dequeueFirstLine();
            continue;
        }

        if (postHits.length > 0) {
            const msg = JSON.stringify({
                error: 'Mojibake audit failed after re-ingest: metadata still contains suspicious strings',
                oldFileId: beforeFileId,
                newFileId,
                levelId: beforeLevelId,
                hitCount: postHits.length,
                hitsSample: postHits.slice(0, 12),
            });
            // eslint-disable-next-line no-console
            console.error(msg);
            if (!continueOnError) {
                process.exit(1);
            }
            failed++;
            await dequeueFirstLine();
            continue;
        }

        // eslint-disable-next-line no-console
        console.error(
            JSON.stringify({
                ok: true,
                oldFileId: beforeFileId,
                newFileId,
                levelId: beforeLevelId,
                postAuditHitCount: 0,
            }),
        );

        await dequeueFirstLine();
        processed++;
    }

    // eslint-disable-next-line no-console
    console.log(
        JSON.stringify({
            ok: true,
            hitsFile,
            processed,
            failed,
            dryRun: false,
            ...(maxFiles !== null
                ? {
                      maxFiles,
                      batchCapReached: lines.length > 0,
                      remainingLinesInQueue: lines.length,
                  }
                : {}),
        }),
    );
}

main().then(() => {
    process.exit(0);
}).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
});
