/**
 * Compare `cdn_files.id` to UUIDs found in R2 object keys (one full bucket listing).
 * Any row whose id never appears in a key is treated as orphan — no per-row HeadObject.
 *
 * Requires .env like the main server: DB_*, CF_* / R2, STORAGE_PUBLIC_CDN_BASE.
 *
 * Usage (from server/):
 *   npx tsx src/misc/scripts/pruneOrphanCdnFiles.ts
 *   npx tsx src/misc/scripts/pruneOrphanCdnFiles.ts --apply
 *   npx tsx src/misc/scripts/pruneOrphanCdnFiles.ts --uuid <file-uuid>
 *   npx tsx src/misc/scripts/pruneOrphanCdnFiles.ts --prefix levels/   # limit listing scope
 */

import dotenv from 'dotenv';

dotenv.config();

import CdnFile from '@/models/cdn/CdnFile.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
import { spacesStorage } from '@/externalServices/cdnService/services/spacesStorage.js';

const cdnSequelize = getSequelizeForModelGroup('cdn');

type CdnFileRow = InstanceType<typeof CdnFile>;

/** UUIDs embedded in keys (levels/, zips/, images/, pack-downloads/, etc.). */
const UUID_IN_KEY =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function uuidsFromKey(key: string): string[] {
    const out: string[] = [];
    let m: RegExpExecArray | null;
    const re = new RegExp(UUID_IN_KEY.source, 'gi');
    while ((m = re.exec(key)) !== null) {
        out.push(m[0].toLowerCase());
    }
    return out;
}

async function buildUuidSetFromStorage(listPrefix: string): Promise<{
    uuids: Set<string>;
    keyCount: number;
}> {
    const uuids = new Set<string>();
    let keyCount = 0;
    for await (const key of spacesStorage.iterateObjectKeys(listPrefix)) {
        keyCount += 1;
        for (const u of uuidsFromKey(key)) {
            uuids.add(u);
        }
    }
    return { uuids, keyCount };
}

function parseArgs(argv: string[]): {
    apply: boolean;
    uuid: string | null;
    prefix: string;
} {
    let apply = false;
    let uuid: string | null = null;
    let prefix = '';
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--apply') {
            apply = true;
            continue;
        }
        if ((a === '--uuid' || a === '-u') && argv[i + 1] !== undefined) {
            uuid = argv[i + 1].trim().toLowerCase();
            i++;
            continue;
        }
        if ((a === '--prefix' || a === '-p') && argv[i + 1] !== undefined) {
            prefix = argv[i + 1].trim();
            i++;
        }
    }
    return { apply, uuid, prefix };
}

async function main(): Promise<void> {
    const { apply, uuid, prefix } = parseArgs(process.argv.slice(2));

    if (prefix) {
        console.warn(
            'Note: --prefix limits which keys are scanned; IDs only stored under other prefixes may be reported as orphans incorrectly.',
        );
    }
    console.log(
        `Listing R2 keys${prefix ? ` (prefix=${JSON.stringify(prefix)})` : ' (whole bucket)'}…`,
    );
    const { uuids: uuidsInStorage, keyCount } = await buildUuidSetFromStorage(prefix);
    console.log(`Indexed ${keyCount} object key(s); ${uuidsInStorage.size} distinct UUID(s) in paths.\n`);

    const where = uuid ? { id: uuid } : undefined;
    const files = await CdnFile.findAll({
        where,
        order: [['createdAt', 'ASC']],
    });

    if (uuid && files.length === 0) {
        console.error(`No cdn_files row for id=${uuid}`);
        process.exitCode = 1;
        return;
    }

    const orphans: CdnFileRow[] = [];

    for (const file of files) {
        const idLower = file.id.toLowerCase();
        if (!uuidsInStorage.has(idLower)) {
            console.log(`ORPHAN\tid=${file.id}\ttype=${file.type}\t(not found in any object key)`);
            orphans.push(file);
        }
    }

    console.log(`\nScanned ${files.length} cdn_files row(s); ${orphans.length} id(s) absent from listed keys.`);

    if (orphans.length === 0) {
        return;
    }

    if (!apply) {
        console.log('Dry run: pass --apply to DELETE these rows from cdn_files (R2 objects unchanged).');
        return;
    }

    for (const row of orphans) {
        await row.destroy();
        console.log(`DELETED\tid=${row.id}`);
    }
    console.log(`Removed ${orphans.length} orphan row(s).`);
}

try {
    await main();
} catch (e) {
    console.error(e);
    process.exitCode = 1;
} finally {
    await cdnSequelize.close();
}
