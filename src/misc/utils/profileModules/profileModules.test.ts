import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_FAVORITE_ITEMS,
  PROFILE_MODULES_FREE_CAP,
  PROFILE_MODULES_STELLAR_CAP,
  ProfileModulesError,
  assertModuleCountAllowed,
  createStockLayout,
  isFavoriteLevelHidden,
  isFavoritePackHidden,
  isFavoritePassHidden,
  isFavoritePlayerHidden,
  parseProfileModulesDocument,
  previousModuleCount,
  profileModulesAuthCaps,
  profileModulesCap,
  readStoredProfileModules,
  resolveLayout,
} from './index.js';

test('stock player layout has six modules and creator has four', () => {
  assert.equal(createStockLayout('player').modules.length, 6);
  assert.equal(createStockLayout('creator').modules.length, 4);
  assert.equal(createStockLayout('player').modules[0].type, 'bio');
  assert.ok(createStockLayout('player').modules.every((m) => m.type !== 'favorite'));
});

test('resolveLayout uses stock when payload is null', () => {
  const layout = resolveLayout(null, 'player');
  assert.equal(layout.length, 6);
  assert.deepEqual(
    layout.map((m) => m.type),
    ['bio', 'tournaments', 'scoreBreakdown', 'difficulty', 'rankHistory', 'scores'],
  );
});

test('profileModulesCap uses catalog free and stellar caps', () => {
  assert.equal(profileModulesCap(false), PROFILE_MODULES_FREE_CAP);
  assert.equal(profileModulesCap(true), PROFILE_MODULES_STELLAR_CAP);
});

test('profileModulesAuthCaps mirrors catalog limits for the auth user payload', () => {
  assert.deepEqual(profileModulesAuthCaps(), {
    profileModulesFreeCap: PROFILE_MODULES_FREE_CAP,
    profileModulesStellarCap: PROFILE_MODULES_STELLAR_CAP,
    profileModulesMaxFavoriteItems: MAX_FAVORITE_ITEMS,
  });
});

test('parse rejects unknown types for the catalog', () => {
  assert.throws(
    () =>
      parseProfileModulesDocument(
        {version: 1, modules: [{id: 'stock-charts', type: 'charts', config: {}}]},
        'player',
      ),
    ProfileModulesError,
  );
  const ok = parseProfileModulesDocument(
    {version: 1, modules: [{id: 'stock-charts', type: 'charts', config: {}}]},
    'creator',
  );
  assert.equal(ok.modules[0].type, 'charts');
});

test('parse rejects duplicate singleton types', () => {
  assert.throws(
    () =>
      parseProfileModulesDocument(
        {
          version: 1,
          modules: [
            {id: 'a', type: 'bio', config: {}},
            {id: 'b', type: 'bio', config: {}},
          ],
        },
        'player',
      ),
    ProfileModulesError,
  );
});

test('parse favorite items and cap', () => {
  const parsed = parseProfileModulesDocument(
    {
      version: 1,
      modules: [
        {
          id: 'fav-1',
          type: 'favorite',
          config: {
            items: [
              {kind: 'level', id: 1},
              {kind: 'pass', id: 2},
              {kind: 'level', id: 1},
            ],
          },
        },
      ],
    },
    'player',
  );
  assert.deepEqual(parsed.modules[0].config.items, [
    {kind: 'level', id: 1},
    {kind: 'pass', id: 2},
  ]);

  const tooMany = Array.from({length: MAX_FAVORITE_ITEMS + 1}, (_, i) => ({
    kind: 'level',
    id: i + 1,
  }));
  assert.throws(
    () =>
      parseProfileModulesDocument(
        {version: 1, modules: [{id: 'fav-1', type: 'favorite', config: {items: tooMany}}]},
        'player',
      ),
    ProfileModulesError,
  );
});

test('cap allows keeping an over-cap layout but not growing it', () => {
  assert.doesNotThrow(() =>
    assertModuleCountAllowed({previousCount: 6, nextCount: 6, cap: 5}),
  );
  assert.doesNotThrow(() =>
    assertModuleCountAllowed({previousCount: 6, nextCount: 5, cap: 5}),
  );
  assert.throws(
    () => assertModuleCountAllowed({previousCount: 6, nextCount: 7, cap: 5}),
    ProfileModulesError,
  );
  assert.throws(
    () => assertModuleCountAllowed({previousCount: 5, nextCount: 6, cap: 5}),
    ProfileModulesError,
  );
  assert.doesNotThrow(() =>
    assertModuleCountAllowed({previousCount: 5, nextCount: 6, cap: 12}),
  );
});

test('previousModuleCount uses stock length when nothing is stored', () => {
  assert.equal(previousModuleCount(null, 'player'), 6);
  assert.equal(previousModuleCount(null, 'creator'), 4);
  assert.equal(
    previousModuleCount({version: 1, modules: [{id: 'x', type: 'bio', config: {}}]}, 'player'),
    1,
  );
});

test('hide flags for favorite entities', () => {
  assert.equal(isFavoriteLevelHidden({isDeleted: true, isHidden: false}), true);
  assert.equal(isFavoriteLevelHidden({isDeleted: false, isHidden: true}), true);
  assert.equal(isFavoriteLevelHidden({isDeleted: false, isHidden: false}), false);

  assert.equal(
    isFavoritePassHidden({
      isDeleted: false,
      isHidden: false,
      level: {isDeleted: false, isHidden: true},
      player: {isBanned: false},
    }),
    true,
  );
  assert.equal(
    isFavoritePassHidden({
      isDeleted: false,
      isHidden: false,
      level: {isDeleted: false, isHidden: false},
      player: {isBanned: true},
    }),
    true,
  );
  assert.equal(
    isFavoritePassHidden({
      isDeleted: false,
      isHidden: false,
      level: {isDeleted: false, isHidden: false},
      player: {isBanned: false},
    }),
    false,
  );

  assert.equal(isFavoritePackHidden({viewMode: 1}), false);
  assert.equal(isFavoritePackHidden({viewMode: 2}), true);
  assert.equal(isFavoritePackHidden({viewMode: 3}), true);
  assert.equal(isFavoritePackHidden({viewMode: 4}), true);

  assert.equal(isFavoritePlayerHidden({isBanned: true}), true);
  assert.equal(isFavoritePlayerHidden({isBanned: false}), false);
  assert.equal(
    isFavoritePassHidden({
      isDeleted: false,
      isHidden: false,
      player: {isBanned: false},
    }),
    true,
  );
});

test('readStoredProfileModules is tolerant of junk', () => {
  assert.equal(readStoredProfileModules(null), null);
  assert.equal(readStoredProfileModules('x'), null);
  const stored = readStoredProfileModules({
    version: 1,
    modules: [{id: 'stock-bio', type: 'bio', config: {nope: true}}],
  });
  assert.equal(stored?.modules[0].type, 'bio');
  assert.deepEqual(stored?.modules[0].config, {});
});
