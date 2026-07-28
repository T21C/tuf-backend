import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';

type TranslationManifest = {
  version: number;
  files: string[];
};

export type TranslationDocument = {
  relativePath: string;
  content: string;
};

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const TRANSLATION_PATH_PATTERN = /^languages\/([A-Za-z0-9_-]+)\/(.+\.json)$/;

let cachedRemoteManifest: TranslationManifest | null = null;
let remoteManifestExpiresAt = 0;
const cachedRemoteDocuments = new Map<
  string,
  {content: string; expiresAt: number}
>();

function positiveEnvInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizedBaseUrl(): string | null {
  const value = process.env.TRANSLATIONS_BASE_URL?.trim();
  return value ? value.replace(/\/+$/, '') : null;
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    positiveEnvInt('FRONTEND_CONTENT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
  );

  try {
    const response = await fetch(url, {signal: controller.signal});
    if (!response.ok) {
      throw new Error(`Frontend content request failed: ${response.status} ${url}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchFrontendJson<T>(url: string): Promise<T> {
  return JSON.parse(await fetchText(url)) as T;
}

function validateManifest(value: unknown): TranslationManifest {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid frontend translation manifest');
  }

  const candidate = value as Partial<TranslationManifest>;
  if (!Array.isArray(candidate.files)) {
    throw new Error('Frontend translation manifest is missing files');
  }

  const files = candidate.files.filter(
    (file): file is string =>
      typeof file === 'string' && TRANSLATION_PATH_PATTERN.test(file),
  );
  return {version: Number(candidate.version) || 1, files: [...new Set(files)].sort()};
}

async function getRemoteManifest(baseUrl: string): Promise<TranslationManifest> {
  if (cachedRemoteManifest && Date.now() < remoteManifestExpiresAt) {
    return cachedRemoteManifest;
  }

  try {
    const manifest = validateManifest(
      await fetchFrontendJson<unknown>(`${baseUrl}/manifest.json`),
    );
    cachedRemoteManifest = manifest;
    remoteManifestExpiresAt =
      Date.now() + positiveEnvInt('FRONTEND_CONTENT_CACHE_TTL_MS', DEFAULT_CACHE_TTL_MS);
    return manifest;
  } catch (error) {
    if (cachedRemoteManifest) return cachedRemoteManifest;
    throw error;
  }
}

function assertLanguage(language: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(language)) {
    throw new Error(`Invalid translation language: ${language}`);
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  const workers = Array.from(
    {length: Math.min(Math.max(concurrency, 1), values.length)},
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await mapper(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function getRemoteTranslationDocuments(
  baseUrl: string,
  language: string,
): Promise<TranslationDocument[]> {
  const manifest = await getRemoteManifest(baseUrl);
  const prefix = `languages/${language}/`;
  const files = manifest.files.filter(file => file.startsWith(prefix));

  return mapWithConcurrency(files, 8, async file => {
    const url = `${baseUrl}/${file}`;
    const cached = cachedRemoteDocuments.get(url);
    if (cached && Date.now() < cached.expiresAt) {
      return {relativePath: file.slice(prefix.length), content: cached.content};
    }

    try {
      const content = await fetchText(url);
      cachedRemoteDocuments.set(url, {
        content,
        expiresAt:
          Date.now() +
          positiveEnvInt('FRONTEND_CONTENT_CACHE_TTL_MS', DEFAULT_CACHE_TTL_MS),
      });
      return {relativePath: file.slice(prefix.length), content};
    } catch (error) {
      if (cached) {
        return {relativePath: file.slice(prefix.length), content: cached.content};
      }
      throw error;
    }
  });
}

async function walkJsonFiles(directory: string, baseDirectory: string): Promise<string[]> {
  const entries = await fs.promises.readdir(directory, {withFileTypes: true});
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkJsonFiles(absolutePath, baseDirectory)));
    } else if (entry.isFile() && path.extname(entry.name) === '.json') {
      files.push(path.relative(baseDirectory, absolutePath));
    }
  }
  return files.sort();
}

async function getLocalTranslationDocuments(
  root: string,
  language: string,
): Promise<TranslationDocument[]> {
  const languageDirectory = path.join(root, 'languages', language);
  try {
    const files = await walkJsonFiles(languageDirectory, languageDirectory);
    return Promise.all(
      files.map(async relativePath => ({
        relativePath,
        content: await fs.promises.readFile(
          path.join(languageDirectory, relativePath),
          'utf8',
        ),
      })),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function getTranslationDocuments(
  language: string,
): Promise<TranslationDocument[]> {
  assertLanguage(language);
  const baseUrl = normalizedBaseUrl();
  if (baseUrl) return getRemoteTranslationDocuments(baseUrl, language);

  const root = process.env.TRANSLATIONS_PATH?.trim();
  if (!root) {
    throw new Error('TRANSLATIONS_BASE_URL or TRANSLATIONS_PATH must be set');
  }
  return getLocalTranslationDocuments(root, language);
}

export async function stageTranslationDocuments(
  language: string,
  destination: string,
): Promise<number> {
  const documents = await getTranslationDocuments(language);
  for (const document of documents) {
    const target = path.join(destination, document.relativePath);
    await fs.promises.mkdir(path.dirname(target), {recursive: true});
    await fs.promises.writeFile(target, document.content, 'utf8');
  }
  return documents.length;
}
