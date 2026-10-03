import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  SITE_LANGUAGE_CONFIGS,
  claimedCountriesForLanguage,
  siteLanguageForCountry,
} from './siteLanguages.js';

test('each country is claimed by at most one language', () => {
  const seen = new Map<string, string>();
  for (const [code, config] of Object.entries(SITE_LANGUAGE_CONFIGS)) {
    for (const country of claimedCountriesForLanguage(config)) {
      const existing = seen.get(country);
      assert.equal(
        existing,
        undefined,
        `Country "${country}" is claimed by both "${existing}" and "${code}"`,
      );
      seen.set(country, code);
    }
  }
});

test('maps player countries to site languages', () => {
  assert.equal(siteLanguageForCountry('CN'), 'cn');
  assert.equal(siteLanguageForCountry('cn'), 'cn');
  assert.equal(siteLanguageForCountry('KR'), 'kr');
  assert.equal(siteLanguageForCountry('AU'), 'en');
  assert.equal(siteLanguageForCountry('US'), 'en');
  assert.equal(siteLanguageForCountry('XX'), 'en');
  assert.equal(siteLanguageForCountry(''), 'en');
  assert.equal(siteLanguageForCountry(null), 'en');
  assert.equal(siteLanguageForCountry(undefined), 'en');
});
