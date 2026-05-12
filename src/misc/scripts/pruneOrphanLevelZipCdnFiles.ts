/**
 * Find `cdn_files` rows with type LEVELZIP whose `id` is not referenced by any `levels.fileId`,
 * then optionally delete each via {@link cdnService.deleteFile} (CDN HTTP DELETE — same path as
 * in-app removal: DB row + Spaces cluster cleanup).
 *
 * Requires server `.env` (DB pools, `LOCAL_CDN_URL` or CDN base URL used by CdnService).
 *
 * Usage (from server/):
 *   npx tsx src/misc/scripts/pruneOrphanLevelZipCdnFiles.ts
 *   npx tsx src/misc/scripts/pruneOrphanLevelZipCdnFiles.ts --apply
 *   npx tsx src/misc/scripts/pruneOrphanLevelZipCdnFiles.ts --file-id <uuid>
 */

import dotenv from 'dotenv';

dotenv.config();

import { Op } from 'sequelize';

import CdnFile from '@/models/cdn/CdnFile.js';
import Level from '@/models/levels/Level.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
import cdnService from '@/server/services/core/CdnService.js';

const levelsSequelize = getSequelizeForModelGroup('levels');
const cdnSequelize = getSequelizeForModelGroup('cdn');

function parseArgs(argv: string[]): { apply: boolean; fileId: string | null } {
    let apply = false;
    let fileId: string | null = null;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--apply') {
            apply = true;
            continue;
        }
        if ((a === '--file-id' || a === '-f') && argv[i + 1] !== undefined) {
            fileId = argv[i + 1].trim();
            i++;
        }
    }
    return { apply, fileId };
}

async function loadReferencedLevelFileIds(): Promise<Set<string>> {
    const rows = await Level.findAll({
        attributes: ['fileId'],
        where: { fileId: { [Op.ne]: null } },
        raw: true,
    });
    const set = new Set<string>();
    for (const r of rows as { fileId: string }[]) {
        if (r.fileId) {
            set.add(String(r.fileId).toLowerCase());
        }
    }
    return set;
}

async function main(): Promise<void> {
    const { apply, fileId } = parseArgs(process.argv.slice(2));

    console.log('Loading levels.fileId references…');
    const referenced = await loadReferencedLevelFileIds();
    console.log(`Found ${referenced.size} distinct non-null level fileId(s).\n`);

    const where = fileId
        ? { id: fileId, type: 'LEVELZIP' as const }
        : { type: 'LEVELZIP' as const };

    const zips = await CdnFile.findAll({
        where,
        order: [['createdAt', 'ASC']],
        attributes: ['id', 'createdAt'],
    });

    if (fileId && zips.length === 0) {
        console.error(`No LEVELZIP cdn_files row for id=${fileId}`);
        process.exitCode = 1;
        return;
    }

    const orphans = zips.filter((z) => !referenced.has(z.id.toLowerCase()));

    for (const z of orphans) {
        console.log(`ORPHAN\tid=${z.id}`);
    }
    console.log(`\nScanned ${zips.length} LEVELZIP row(s); ${orphans.length} not referenced by levels.fileId.`);

    if (orphans.length === 0) {
        return;
    }

    if (!apply) {
        console.log('Dry run: pass --apply to call cdnService.deleteFile() for each orphan.');
        return;
    }

    for (const row of orphans) {
        const id = row.id;
        process.stdout.write(`DELETE\t${id} … `);
        try {
            await cdnService.deleteFile(id);
            console.log('ok');
        } catch (e) {
            console.log(`FAILED\t${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

try {
    await main();
} catch (e) {
    console.error(e);
    process.exitCode = 1;
} finally {
    await levelsSequelize.close();
    await cdnSequelize.close();
}
