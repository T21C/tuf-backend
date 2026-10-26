import assert from 'node:assert/strict';
import test from 'node:test';
import {resolveBillingDisplayCurrency} from './tufStellarDisplayCurrencyLocale.js';

test('explicit site language picks that language currency', () => {
  const korean = resolveBillingDisplayCurrency({
    appLanguage: 'kr',
    playerCountry: 'US',
    geoCountry: 'DE',
  });
  assert.equal(korean.country, 'KR');
  assert.equal(korean.currency, 'KRW');

  const polish = resolveBillingDisplayCurrency({
    appLanguage: 'pl',
    playerCountry: 'US',
    geoCountry: 'KR',
  });
  assert.equal(polish.country, 'PL');
  assert.equal(polish.currency, 'PLN');

  assert.equal(
    resolveBillingDisplayCurrency({appLanguage: 'jp', playerCountry: 'US'}).currency,
    'JPY',
  );
  assert.equal(
    resolveBillingDisplayCurrency({appLanguage: 'id', playerCountry: 'US'}).currency,
    'IDR',
  );
  assert.equal(resolveBillingDisplayCurrency({appLanguage: 'en'}).currency, 'USD');
  assert.equal(resolveBillingDisplayCurrency({appLanguage: 'de'}).currency, 'EUR');
  assert.equal(resolveBillingDisplayCurrency({appLanguage: 'fr'}).currency, 'EUR');
  assert.equal(resolveBillingDisplayCurrency({appLanguage: 'es'}).currency, 'EUR');
  assert.equal(resolveBillingDisplayCurrency({appLanguage: 'cn', playerCountry: 'TW'}).currency, 'CNY');
  assert.equal(resolveBillingDisplayCurrency({appLanguage: 'ru', playerCountry: 'PL'}).currency, 'USD');
});

test('follow country uses the player profile country', () => {
  const japan = resolveBillingDisplayCurrency({
    appLanguage: null,
    playerCountry: 'jp',
    geoCountry: 'US',
  });
  assert.equal(japan.country, 'JP');
  assert.equal(japan.currency, 'JPY');

  const taiwan = resolveBillingDisplayCurrency({
    appLanguage: '',
    playerCountry: 'TW',
    geoCountry: 'US',
  });
  assert.equal(taiwan.currency, 'TWD');

  const canada = resolveBillingDisplayCurrency({
    appLanguage: 'zz',
    playerCountry: 'CA',
    geoCountry: 'US',
  });
  assert.equal(canada.currency, 'CAD');
});

test('unset country uses the language follow-country would show', () => {
  const unset = resolveBillingDisplayCurrency({
    appLanguage: null,
    playerCountry: 'XX',
    geoCountry: 'GB',
  });
  assert.equal(unset.country, 'US');
  assert.equal(unset.currency, 'USD');

  const missing = resolveBillingDisplayCurrency({
    appLanguage: null,
    playerCountry: null,
    geoCountry: 'KR',
  });
  assert.equal(missing.country, 'US');
  assert.equal(missing.currency, 'USD');
});
