import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CONTINENT_COUNTRY_CODES} from './countryFilter.js';

/**
 * Contract copy of client/src/utils/countryCodes.js (excluding XX) and
 * client/src/utils/continents.js. Backend CI checks out this repo alone.
 */
const LEADERBOARD_COUNTRY_CODES = [
  'AF', 'AL', 'DZ', 'AD', 'AO', 'AG', 'AR', 'AM', 'AU', 'AT', 'AZ', 'BS',
  'BH', 'BD', 'BB', 'BY', 'BE', 'BZ', 'BJ', 'BT', 'BO', 'BA', 'BW', 'BR',
  'BN', 'BG', 'BF', 'BI', 'KH', 'CM', 'CA', 'CV', 'CF', 'TD', 'CL', 'CN',
  'CO', 'KM', 'CG', 'CR', 'HR', 'CU', 'CY', 'CZ', 'DK', 'DJ', 'DM', 'DO',
  'EC', 'EG', 'SV', 'GQ', 'ER', 'EE', 'ET', 'FJ', 'FI', 'FR', 'GA', 'GM',
  'GE', 'DE', 'GH', 'GR', 'GD', 'GT', 'GN', 'GW', 'GY', 'HT', 'HN', 'HK',
  'HU', 'IS', 'IN', 'ID', 'IR', 'IQ', 'IE', 'IL', 'IT', 'JM', 'JP', 'JO',
  'KZ', 'KE', 'KI', 'KP', 'KR', 'KW', 'KG', 'LA', 'LV', 'LB', 'LS', 'LR',
  'LY', 'LI', 'LT', 'LU', 'MO', 'MK', 'MG', 'MW', 'MY', 'MV', 'ML', 'MT',
  'MH', 'MR', 'MU', 'MX', 'FM', 'MD', 'MC', 'MN', 'ME', 'MA', 'MZ', 'MM',
  'NA', 'NR', 'NP', 'NL', 'NZ', 'NI', 'NE', 'NG', 'NO', 'OM', 'PK', 'PW',
  'PS', 'PA', 'PG', 'PY', 'PE', 'PH', 'PL', 'PT', 'QA', 'RO', 'RU', 'RW',
  'KN', 'LC', 'VC', 'WS', 'SM', 'ST', 'SA', 'SN', 'RS', 'SC', 'SL', 'SG',
  'SK', 'SI', 'SB', 'SO', 'ZA', 'SS', 'ES', 'LK', 'SD', 'SR', 'SE', 'CH',
  'SY', 'TW', 'TJ', 'TZ', 'TH', 'TL', 'TG', 'TO', 'TT', 'TN', 'TR', 'TM',
  'TV', 'UG', 'UA', 'AE', 'GB', 'US', 'UY', 'UZ', 'VU', 'VA', 'VE', 'VN',
  'YE', 'ZM', 'ZW',
];

const LEADERBOARD_CONTINENT_CODES = ['AFR', 'ASI', 'EUR', 'NAM', 'OCE', 'SAM'];

test('each leaderboard country belongs to one continent', () => {
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

  const missing = LEADERBOARD_COUNTRY_CODES.filter((code) => !seen.has(code));
  const extra = [...seen.keys()].filter((code) => !LEADERBOARD_COUNTRY_CODES.includes(code));
  assert.deepEqual(missing, [], `countries missing a continent: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `continent codes missing from the country list: ${extra.join(', ')}`);
});

test('leaderboard continent options match the country groups', () => {
  const optionCodes = [...LEADERBOARD_CONTINENT_CODES].sort();
  const groupCodes = Object.keys(CONTINENT_COUNTRY_CODES).sort();
  assert.deepEqual(optionCodes, groupCodes);
});
