/**
 * One-off: ingest directly fetchable non-GitHub mod zips into the CDN.
 * Default is dry-run. Pass --apply to upload and update `mod_versions.downloadUrl`.
 *
 * Skips URLs already on the CDN and every github.com / www.github.com URL
 * (no GitHub API or HTML scrape). Only bodies with zip magic are ingested.
 *
 * sudo docker compose --env-file /srv/tuf/config/stack.env \
 *   -f /srv/tuf/infra/compose.yml run --rm --no-deps api \
 *   node dist/misc/scripts/importModReleaseZipsToCdn.js --apply
 */
import dotenv from 'dotenv';

dotenv.config();

import axios from 'axios';
import {getSequelizeForModelGroup} from '@/config/db.js';
import ModVersion from '@/models/misc/ModVersion.js';
import {isCdnUrl} from '@/misc/utils/Utility.js';
import {logger} from '@/server/services/core/LoggerService.js';
import cdnService from '@/server/services/core/CdnService.js';
import {syncModLatestFromVersions} from '@/server/services/mods/modCatalog.js';
import {classifyModReleaseImport} from '@/server/services/mods/modReleaseImportClassify.js';
import {MOD_ZIP_MAX_BYTES} from '@/server/services/mods/modZipLimits.js';

const DOWNLOAD_TIMEOUT_MS = 120_000;
const DOWNLOAD_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
};

function applyRequested(argv: string[]): boolean {
  return argv.includes('--apply');
}

function zipFilenameFromUrl(url: string, versionId: number): string {
  try {
    const base = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    if (base.toLowerCase().endsWith('.zip')) return base;
  } catch {
    // ignore invalid URL
  }
  return `mod-release-${versionId}.zip`;
}

async function fetchReleaseBody(url: string): Promise<{
  ok: boolean;
  contentType: string | null;
  buffer: Buffer | null;
  error?: string;
}> {
  try {
    const response = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxRedirects: 5,
      maxContentLength: MOD_ZIP_MAX_BYTES,
      maxBodyLength: MOD_ZIP_MAX_BYTES,
      headers: DOWNLOAD_HEADERS,
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) {
      return {ok: false, contentType: null, buffer: null, error: `HTTP ${response.status}`};
    }
    const buffer = Buffer.from(response.data);
    const contentType =
      typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : null;
    return {ok: true, contentType, buffer};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {ok: false, contentType: null, buffer: null, error: message};
  }
}

async function main() {
  const apply = applyRequested(process.argv.slice(2));
  const sequelize = getSequelizeForModelGroup('admin');
  await sequelize.authenticate();

  const versions = await ModVersion.findAll({
    attributes: ['id', 'modId', 'version', 'downloadUrl'],
    order: [['id', 'ASC']],
  });

  const counts = {
    scanned: versions.length,
    skippedCdn: 0,
    skippedGithub: 0,
    skippedNotZip: 0,
    ingest: 0,
    failed: 0,
  };
  const touchedModIds = new Set<number>();

  logger.info(`importModReleaseZipsToCdn ${apply ? 'APPLY' : 'dry-run'} (${versions.length} versions)`);

  for (const row of versions) {
    const downloadUrl = row.downloadUrl;
    const early = classifyModReleaseImport({
      downloadUrl,
      isCdn: isCdnUrl(downloadUrl),
    });
    if (early.action === 'skip' && early.reason === 'cdn') {
      counts.skippedCdn += 1;
      continue;
    }
    if (early.action === 'skip' && early.reason === 'github') {
      counts.skippedGithub += 1;
      continue;
    }

    const fetched = await fetchReleaseBody(downloadUrl);
    if (!fetched.ok || !fetched.buffer) {
      counts.skippedNotZip += 1;
      logger.info(`skip not-zip #${row.id} ${row.version}: ${fetched.error || 'empty body'} ${downloadUrl}`);
      continue;
    }

    const decision = classifyModReleaseImport({
      downloadUrl,
      isCdn: false,
      contentType: fetched.contentType,
      headBytes: fetched.buffer.subarray(0, 4),
    });
    if (decision.action === 'skip') {
      counts.skippedNotZip += 1;
      logger.info(`skip ${decision.reason} #${row.id} ${row.version} ${downloadUrl}`);
      continue;
    }

    counts.ingest += 1;
    if (!apply) {
      logger.info(`would ingest #${row.id} ${row.version} (${fetched.buffer.length} bytes) ${downloadUrl}`);
      continue;
    }

    try {
      const filename = zipFilenameFromUrl(downloadUrl, row.id);
      const uploaded = await cdnService.uploadModZip(fetched.buffer, filename);
      await row.update({downloadUrl: uploaded.url});
      touchedModIds.add(row.modId);
      logger.info(`ingested #${row.id} ${row.version} -> ${uploaded.url}`);
    } catch (error) {
      counts.failed += 1;
      counts.ingest -= 1;
      logger.error(`failed ingest #${row.id} ${row.version}`, error);
    }
  }

  if (apply) {
    for (const modId of touchedModIds) {
      await syncModLatestFromVersions(modId);
    }
  }

  logger.info('importModReleaseZipsToCdn done', {
    apply,
    ...counts,
    modsSynced: apply ? touchedModIds.size : 0,
  });
  process.exit(0);
}

main().catch((error) => {
  logger.error('importModReleaseZipsToCdn failed', error);
  process.exit(1);
});
