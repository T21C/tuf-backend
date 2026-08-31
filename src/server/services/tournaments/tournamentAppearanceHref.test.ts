import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * Contract copy of client/src/utils/tournamentAppearanceHref.js.
 * Public catalog links must prefer /tournaments/:id before pack / external / YouTube.
 */
function resolvePackHref(packRef: string | null | undefined): string | null {
  if (!packRef) return null;
  return `/packs/${encodeURIComponent(String(packRef))}`;
}

function resolveTournamentPageHref(tournament: {id?: number | string | null} | null | undefined): string | null {
  const id = Number(tournament?.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return `/tournaments/${id}`;
}

function resolveTournamentAppearanceHref(appearance: {
  tournament?: {
    id?: number | string | null;
    packRef?: string | null;
    externalUrl?: string | null;
    youtubeUrl?: string | null;
  } | null;
}): {href: string | null; external: boolean} {
  const tournament = appearance?.tournament;
  if (!tournament) return {href: null, external: false};

  const pageHref = resolveTournamentPageHref(tournament);
  if (pageHref) return {href: pageHref, external: false};

  const packHref = resolvePackHref(tournament.packRef);
  if (packHref) return {href: packHref, external: false};

  const externalUrl =
    typeof tournament.externalUrl === 'string' && tournament.externalUrl.trim()
      ? tournament.externalUrl.trim()
      : null;
  if (externalUrl) return {href: externalUrl, external: true};

  const youtubeUrl =
    typeof tournament.youtubeUrl === 'string' && tournament.youtubeUrl.trim()
      ? tournament.youtubeUrl.trim()
      : null;
  if (youtubeUrl) return {href: youtubeUrl, external: true};

  return {href: null, external: false};
}

void test('appearance href prefers the tournament page over pack and external urls', () => {
  const appearance = {
    tournament: {
      id: 17,
      packRef: 'summer-pack',
      externalUrl: 'https://example.com/event',
      youtubeUrl: 'https://youtube.com/watch?v=abc',
    },
  };
  assert.equal(resolveTournamentPageHref(appearance.tournament), '/tournaments/17');
  assert.deepEqual(resolveTournamentAppearanceHref(appearance), {
    href: '/tournaments/17',
    external: false,
  });
});

void test('appearance href falls back to pack then external then youtube', () => {
  assert.deepEqual(
    resolveTournamentAppearanceHref({
      tournament: {packRef: 'summer-pack', youtubeUrl: 'https://youtube.com/watch?v=abc'},
    }),
    {href: '/packs/summer-pack', external: false},
  );
  assert.deepEqual(
    resolveTournamentAppearanceHref({
      tournament: {externalUrl: 'https://example.com/event', youtubeUrl: 'https://youtube.com/watch?v=abc'},
    }),
    {href: 'https://example.com/event', external: true},
  );
  assert.deepEqual(
    resolveTournamentAppearanceHref({
      tournament: {youtubeUrl: 'https://youtube.com/watch?v=abc'},
    }),
    {href: 'https://youtube.com/watch?v=abc', external: true},
  );
  assert.deepEqual(resolveTournamentAppearanceHref({}), {href: null, external: false});
});
