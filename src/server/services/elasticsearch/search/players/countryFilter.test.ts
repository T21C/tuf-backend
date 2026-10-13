import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CONTINENT_COUNTRY_CODES} from './countryFilter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientUtils = path.resolve(here, '../../../../../../../client/src/utils');

function codesIn(fileName: string): string[] {
  const source = readFileSync(path.join(clientUtils, fileName), 'utf8');
  return [...source.matchAll(/code: '([A-Z]{2,3})'/g)].map((match) => match[1]);
}

test('each leaderboard country belongs to one continent', () => {
  const countries = codesIn('countryCodes.js').filter((code) => code !== 'XX');
  const seen = new Map<string, string>();

  for (const [continent, members] of Object.entries(CONTINENT_COUNTRY_CODES)) {
    assert.ok(members.length > 0, `${continent} has no countries`);
    for (const country of members) {
      assert.match(country, /^[A-Z]{2}$/, `${continent} has invalid code ${country}`);
      const existing = seen.get(country);
      assert.equal(existing, undefined, `${country} is in both ${existing} and ${continent}`);
      seen.set(country, continent);
    }
  }

  const missing = countries.filter((code) => !seen.has(code));
  const extra = [...seen.keys()].filter((code) => !countries.includes(code));
  assert.deepEqual(missing, [], `countries missing a continent: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `continent codes missing from the country list: ${extra.join(', ')}`);
});

test('leaderboard continent options match the country groups', () => {
  const optionCodes = codesIn('continents.js').sort();
  const groupCodes = Object.keys(CONTINENT_COUNTRY_CODES).sort();
  assert.deepEqual(optionCodes, groupCodes);
});
