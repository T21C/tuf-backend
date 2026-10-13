/**
 * Leaderboard continent filters.
 * Membership follows UN M49, with Central America and the Caribbean in North America.
 * Transcontinental countries use their UN region: Russia is Europe; Turkey, Cyprus,
 * Kazakhstan, and the Caucasus are Asia.
 * Keep codes in sync with client/src/utils/continents.js.
 */
export const CONTINENT_COUNTRY_CODES: Record<string, readonly string[]> = {
  AFR: [
    'AO', 'BF', 'BI', 'BJ', 'BW', 'CF', 'CG', 'CM', 'CV', 'DJ', 'DZ', 'EG', 'ER', 'ET',
    'GA', 'GH', 'GM', 'GN', 'GQ', 'GW', 'KE', 'KM', 'LR', 'LS', 'LY', 'MA', 'MG', 'ML',
    'MR', 'MU', 'MW', 'MZ', 'NA', 'NE', 'NG', 'RW', 'SC', 'SD', 'SL', 'SN', 'SO', 'SS',
    'ST', 'TD', 'TG', 'TN', 'TZ', 'UG', 'ZA', 'ZM', 'ZW',
  ],
  ASI: [
    'AE', 'AF', 'AM', 'AZ', 'BD', 'BH', 'BN', 'BT', 'CN', 'CY', 'GE', 'HK', 'ID', 'IL',
    'IN', 'IQ', 'IR', 'JO', 'JP', 'KG', 'KH', 'KP', 'KR', 'KW', 'KZ', 'LA', 'LB', 'LK',
    'MM', 'MN', 'MO', 'MV', 'MY', 'NP', 'OM', 'PH', 'PK', 'PS', 'QA', 'SA', 'SG', 'SY',
    'TH', 'TJ', 'TL', 'TM', 'TR', 'TW', 'UZ', 'VN', 'YE',
  ],
  EUR: [
    'AD', 'AL', 'AT', 'BA', 'BE', 'BG', 'BY', 'CH', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI',
    'FR', 'GB', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MC', 'MD',
    'ME', 'MK', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'RS', 'RU', 'SE', 'SI', 'SK', 'SM',
    'UA', 'VA',
  ],
  NAM: [
    'AG', 'BB', 'BS', 'BZ', 'CA', 'CR', 'CU', 'DM', 'DO', 'GD', 'GT', 'HN', 'HT', 'JM',
    'KN', 'LC', 'MX', 'NI', 'PA', 'SV', 'TT', 'US', 'VC',
  ],
  OCE: [
    'AU', 'FJ', 'FM', 'KI', 'MH', 'NR', 'NZ', 'PG', 'PW', 'SB', 'TO', 'TV', 'VU', 'WS',
  ],
  SAM: [
    'AR', 'BO', 'BR', 'CL', 'CO', 'EC', 'GY', 'PE', 'PY', 'SR', 'UY', 'VE',
  ],
};

export function continentCountries(code: string): readonly string[] | null {
  if (!Object.hasOwn(CONTINENT_COUNTRY_CODES, code)) return null;
  return CONTINENT_COUNTRY_CODES[code];
}
