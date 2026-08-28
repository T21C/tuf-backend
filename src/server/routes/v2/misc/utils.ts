import express, {Request, Response, Router} from 'express';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { Auth } from '@/server/middleware/auth.js';
import { errorResponseSchema, standardErrorResponses400500, standardErrorResponses500 } from '@/server/schemas/v2/misc/index.js';
import fs from 'fs';
import path from 'path';
import { logger } from '@/server/services/core/LoggerService.js';
import multer from 'multer';
import { withUtf8Filenames } from '@/misc/utils/multipartFilename.js';
import { withWorkspace } from '@/server/services/core/WorkspaceService.js';
import {
    extractAll as archiveExtractAll,
    createZip as archiveCreateZip,
    detectArchiveFormat,
    getArchiveExtension
} from '@/externalServices/cdnService/infra/archive/archiveService.js';
import {
  getTranslationDocuments,
  stageTranslationDocuments,
} from '@/server/services/core/FrontendContentService.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  }
});

const router: Router = express.Router();

import {SITE_LANGUAGE_CONFIGS} from '@/config/siteLanguages.js';

const languageConfigs = SITE_LANGUAGE_CONFIGS;

interface MulterRequest extends Request {
  file?: Express.Multer.File;
}

// Get object keys recursively
function getKeysRecursively(obj: any, prefix = ''): string[] {
  let keys: string[] = [];

  for (const key in obj) {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      keys = keys.concat(
        getKeysRecursively(obj[key], prefix ? `${prefix}.${key}` : key),
      );
    } else {
      keys.push(prefix ? `${prefix}.${key}` : key);
    }
  }

  return keys;
}

// Utility to find the first directory containing JSON files
function findTranslationRoot(dir: string): string | null {
  const list = fs.readdirSync(dir);

  // If there are JSON files in the current directory, return the current directory
  if (list.some(file => path.extname(file) === '.json')) {
    return dir;
  }

  // Identify subdirectories
  const subdirs = list.filter(file => {
    try {
      return fs.statSync(path.join(dir, file)).isDirectory();
    } catch {
      return false;
    }
  });

  // If there's only one subdirectory, recurse into it
  if (subdirs.length === 1 && !subdirs[0].endsWith('.json')) {
    return findTranslationRoot(path.join(dir, subdirs[0]));
  }

  // If there are multiple subdirectories, check each for JSON files
  for (const subdir of subdirs) {
    const subList = fs.readdirSync(path.join(dir, subdir));
    if (subList.some(file => path.extname(file) === '.json')) {
      return dir;
    }
  }

  // No directory with JSON files found
  return null;
}

// Verify translations endpoint
router.post(
  '/verify-translations',
  Auth.user(),
  ApiDoc({
    operationId: 'postUtilsVerifyTranslations',
    summary: 'Verify translation ZIP',
    description: 'Upload a ZIP of translation JSON files; returns validation result (missing keys, structure).',
    tags: ['Utils'],
    security: ['bearerAuth'],
    requestBody: { description: 'Multipart form with translationZip file', required: true },
    responses: {
      200: { description: 'Validation result (valid, missingKeys, etc.)' },
      400: { description: 'No file or invalid ZIP', schema: errorResponseSchema },
      500: { description: 'Server error', schema: errorResponseSchema },
    },
  }),
  withUtf8Filenames(upload.single('translationZip')),
  async (req: MulterRequest, res: Response) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({error: 'No file uploaded'});
      }

      const fileBuffer = req.file.buffer;
      const uploadedName = req.file.originalname || 'upload.bin';
      // Extraction happens inside a workspace lease so the temp dir is removed even on crash /
      // SIGTERM mid-flight; no manual cleanup branches needed.
      const result = await withWorkspace('translation-verify', async (ws) => {
        // Persist the uploaded buffer to disk first — archiveService is file-based, and
        // the format may be .zip / .7z / .rar / .tar / .tar.gz.
        const detected = detectArchiveFormat(uploadedName, fileBuffer);
        const archiveExt = detected ? getArchiveExtension(detected) : path.extname(uploadedName) || '.bin';
        const archivePath = ws.join(`translation-upload${archiveExt}`);
        const extractDir = ws.join('extracted');
        await fs.promises.writeFile(archivePath, fileBuffer);
        await fs.promises.mkdir(extractDir, { recursive: true });

        try {
          await archiveExtractAll(archivePath, extractDir);
        } catch (zipError) {
          logger.debug('Translation archive extraction failed', {
            uploadedName,
            error: zipError instanceof Error ? zipError.message : String(zipError)
          });
          throw {
            code: 400,
            error:
              'Failed to extract archive. Supported formats: .zip, .7z, .rar, .tar, .tar.gz / .tgz.',
          };
        }

        const translationRoot = findTranslationRoot(extractDir);
        logger.debug('translationRoot', translationRoot);
        if (!translationRoot) {
          throw {
            code: 400,
            error:
              'No translation files found in the archive. Make sure the archive contains JSON files either directly or in an immediate subdirectory',
          };
        }

        const enDocuments = await getTranslationDocuments('en');
        if (enDocuments.length === 0) {
          throw new Error('English translation source is empty');
        }

        const missingFiles: string[] = [];
        const missingKeys: {[file: string]: string[]} = {};
        const extraKeys: {[file: string]: string[]} = {};

        enDocuments.forEach(document => {
          const relativePath = document.relativePath;
          const uploadedFile = path.join(translationRoot, relativePath);

          if (!fs.existsSync(uploadedFile)) {
            missingFiles.push(relativePath);
            return;
          }

          const enContent = JSON.parse(document.content);
          const uploadedContent = JSON.parse(
            fs.readFileSync(uploadedFile, 'utf8'),
          );

          const enKeys = getKeysRecursively(enContent);
          const uploadedKeys = getKeysRecursively(uploadedContent);

          const missing = enKeys.filter(key => !uploadedKeys.includes(key));
          const extra = uploadedKeys.filter(key => !enKeys.includes(key));

          if (missing.length > 0) {
            missingKeys[relativePath] = missing;
          }
          if (extra.length > 0) {
            extraKeys[relativePath] = extra;
          }
        });

        return {
          missingFiles,
          missingKeys,
          extraKeys,
          isValid:
            missingFiles.length === 0 && Object.keys(missingKeys).length === 0,
        };
      });

      return res.json(result);
    } catch (error: any) {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        return res.status(error.code || 400).json({
          error: error.error || 'Bad Request',
          details: error.details || undefined,
        });
      }
      logger.error('Error verifying translations:', error);
      return res.status(500).json({
        error: 'Failed to verify translations',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

// Download English translations endpoint
router.get(
  '/download-translations',
  ApiDoc({
    operationId: 'getUtilsDownloadTranslationsEn',
    summary: 'Download English translations ZIP',
    description: 'Returns a ZIP of all English translation JSON files.',
    tags: ['Utils'],
    responses: {
      200: { description: 'ZIP file (en-translations.zip)' },
      500: { description: 'Failed to create ZIP', schema: errorResponseSchema },
    },
  }),
  async (req: Request, res: Response) => {
  try {
    // res.download completes before the workspace lease ends, so the zip file is still around
    // during streaming and gets removed the moment delivery finishes.
    await withWorkspace('translation-download', async (ws) => {
      const stagingDir = ws.join('staging');
      const tempZipPath = ws.join('en-translations.zip');
      await fs.promises.mkdir(stagingDir, { recursive: true });
      const staged = await stageTranslationDocuments('en', stagingDir);
      if (staged === 0) throw new Error('English translation source is empty');
      await archiveCreateZip(stagingDir, tempZipPath);

      await new Promise<void>((resolve) => {
        res.download(tempZipPath, 'en-translations.zip', err => {
          if (err) {
            logger.error('Error sending translations zip:', err);
          }
          resolve();
        });
      });
    });
  } catch (error) {
    logger.error('Error creating translations zip:', error);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Failed to create translations zip',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }
  }
);

// Language configuration - now dynamic based on directory check
const languages: {[key: string]: {display: string; countryCode: string; folder: string; status: number; contributors: string[]}} = {};

// Function to check if a language is implemented
async function checkLanguageImplementation(langCode: string): Promise<number> {
  try {
    const [langDocuments, enDocuments] = await Promise.all([
      getTranslationDocuments(langCode),
      getTranslationDocuments('en'),
    ]);
    if (langDocuments.length === 0 || enDocuments.length === 0) return 0;

    const langByPath = new Map(
      langDocuments.map(document => [document.relativePath, document.content]),
    );

    let missingFiles = 0;
    let missingKeys = 0;
    let totalKeys = 0;

    // Check if all English files exist in the language directory
    for (const enDocument of enDocuments) {
      const langContentText = langByPath.get(enDocument.relativePath);
      if (!langContentText) {
        missingFiles++;
        continue;
      }

      // Compare keys in each file
      const enContent = JSON.parse(enDocument.content);
      const langContent = JSON.parse(langContentText);

      const enKeys = getKeysRecursively(enContent);
      const langKeys = getKeysRecursively(langContent);

      totalKeys += enKeys.length;
      missingKeys += enKeys.filter(key => !langKeys.includes(key)).length;
    }

    // Calculate implementation percentage
    const fileCompletion =
      ((enDocuments.length - missingFiles) / enDocuments.length) * 100;
    const keyCompletion = ((totalKeys - missingKeys) / totalKeys) * 100;
    const overallCompletion = (fileCompletion + keyCompletion) / 2;

    logger.debug(`language: ${langCode} completion: ${overallCompletion}`);
    return overallCompletion;
  } catch (error) {
    logger.error(`Error checking implementation for ${langCode}:`, error);
    return 0;
  }
}

// Initialize languages configuration
async function initializeLanguages() {
  // Check each language's implementation
  for (const [code, config] of Object.entries(languageConfigs)) {
    const status = await checkLanguageImplementation(code);
    languages[code] = {
      ...config,
      status,
    };
  }
}

// Initialize languages on server start
initializeLanguages().catch(error => {
  logger.error('Error initializing languages:', error);
});

// Get list of available languages
router.get(
  '/languages',
  ApiDoc({
    operationId: 'getUtilsLanguages',
    summary: 'List languages (raw)',
    description: 'Returns available translation languages with completion status (raw object).',
    tags: ['Utils'],
    responses: { 200: { description: 'Languages map (code -> display, countryCode, folder, status, contributors)' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
  try {
    res.json(languages);
  } catch (error) {
    logger.error('Error getting languages list:', error);
    res.status(500).json({
      error: 'Failed to get languages list',
      details: error instanceof Error ? error.message : String(error),
    });
  }
  }
);

// Type for languages
type LanguageCode = keyof typeof languages;

// Download translations for a specific language
router.get(
  '/download-translations/:lang',
  ApiDoc({
    operationId: 'getUtilsDownloadTranslationsByLang',
    summary: 'Download translations ZIP by language',
    description: 'Returns a ZIP of translation JSON files for the given language code (e.g. en, pl, kr).',
    tags: ['Utils'],
    params: { lang: { description: 'Language code', schema: { type: 'string' } } },
    responses: {
      200: { description: 'ZIP file ({lang}-translations.zip)' },
      404: { description: 'Language or translations not found', schema: errorResponseSchema },
      500: { description: 'Failed to create ZIP', schema: errorResponseSchema },
    },
  }),
  async (req: Request, res: Response) => {
    const {lang} = req.params;

    try {
      if (!languageConfigs[lang]) {
        return res.status(404).json({error: 'Language not found'});
      }

      await withWorkspace('translation-download', async (ws) => {
        const stagingDir = ws.join('staging');
        const tempZipPath = ws.join(`${lang}-translations.zip`);
        await fs.promises.mkdir(stagingDir, { recursive: true });
        const staged = await stageTranslationDocuments(lang, stagingDir);
        if (staged === 0) {
          throw {code: 404, error: 'Translations not found for this language'};
        }
        await archiveCreateZip(stagingDir, tempZipPath);

        await new Promise<void>((resolve) => {
          res.download(tempZipPath, `${lang}-translations.zip`, err => {
            if (err) {
              logger.error(`Error sending ${lang} translations zip:`, err);
            }
            resolve();
          });
        });
      });
      return;
    } catch (error) {
      logger.error(`Error creating ${lang} translations zip:`, error);
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Failed to create translations zip',
          details: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
  },
);

router.get(
  '/languages',
  ApiDoc({
    operationId: 'getUtilsLanguagesInfo',
    summary: 'List languages (array)',
    description: 'Returns available translation languages as an array of { code, display, countryCode, folder, status, contributors }.',
    tags: ['Utils'],
    responses: { 200: { description: 'Array of language info' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
  try {
    const languagesInfo = Object.entries(languages).map(([code, info]) => ({
      code,
      display: info.display,
      countryCode: info.countryCode,
      folder: info.folder,
      status: info.status,
      contributors: info.contributors,
    }));

    res.json(languagesInfo);
  } catch (error) {
    logger.error('Error getting languages list:', error);
    res.status(500).json({
      error: 'Failed to get languages list',
      details: error instanceof Error ? error.message : String(error),
    });
  }
  }
);

export default router;
