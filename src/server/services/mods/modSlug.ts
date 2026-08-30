export const MOD_SLUG_MAX = 80;
export const MOD_VERSION_FALLBACK = 'unspecified';
export const RESERVED_MOD_SLUGS = new Set(['tags', 'edit', 'download', 'like', 'isliked']);

export function uniqueWithNumericSuffix(desired: string, taken: Iterable<string>): string {
  const used = taken instanceof Set ? taken : new Set(taken);
  const base = desired.trim() || 'mod';
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export function slugifyToken(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MOD_SLUG_MAX);
}

export function slugifyName(name: string): string {
  const parts = String(name || '')
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  if (!parts || parts.length === 0) return '';
  return parts.join('-').slice(0, MOD_SLUG_MAX);
}

export function githubRepoSlugFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.replace(/^\/+|\/+$/g, '');
    const parts = path.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    let repo = '';
    if (host === 'github.com' || host === 'www.github.com') {
      repo = parts[1].replace(/\.git$/i, '');
    } else if (host.endsWith('.githubusercontent.com')) {
      repo = parts[1].replace(/\.git$/i, '');
    } else {
      return null;
    }
    const slug = slugifyToken(repo);
    return slug || null;
  } catch {
    return null;
  }
}

export function isReservedModSlug(slug: string): boolean {
  return RESERVED_MOD_SLUGS.has(String(slug || '').toLowerCase());
}

export function normalizeModSlug(raw: string): string | null {
  const slug = slugifyToken(raw);
  if (!slug || isReservedModSlug(slug)) return null;
  return slug;
}

export type SlugSource = {
  projectUrl?: string | null;
  downloadUrl?: string | null;
  name?: string | null;
  fallbackIndex: number;
};

export function preferredModSlug(source: SlugSource): string {
  const fromProject = source.projectUrl ? githubRepoSlugFromUrl(source.projectUrl) : null;
  if (fromProject) return fromProject;
  const fromDownload = source.downloadUrl ? githubRepoSlugFromUrl(source.downloadUrl) : null;
  if (fromDownload) return fromDownload;
  const fromName = slugifyName(source.name || '');
  if (fromName) return fromName;
  const index = Number.isFinite(source.fallbackIndex) && source.fallbackIndex > 0
    ? Math.floor(source.fallbackIndex)
    : 1;
  return String(index);
}

export function allocateModSlug(source: SlugSource, taken: Iterable<string>): string {
  const used = new Set(
    [...taken].map((value) => String(value || '').toLowerCase()).filter(Boolean),
  );
  for (const reserved of RESERVED_MOD_SLUGS) used.add(reserved);
  return uniqueWithNumericSuffix(preferredModSlug(source), used);
}

export function normalizeVersionLabel(raw: string | null | undefined): string {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return MOD_VERSION_FALLBACK;
  return trimmed.slice(0, 64);
}
