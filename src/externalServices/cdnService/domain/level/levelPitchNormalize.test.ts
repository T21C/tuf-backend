import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isNeutralPitch,
    stripNonDefaultPitchFromSettingsRecord,
    stripNonDefaultPitchInLevelText
} from './levelPitchNormalize.js';

function chart(settings: string, extra = ''): string {
    return `{
  "angleData": [0, 180],
  "settings": ${settings}${extra}
}`;
}

void test('isNeutralPitch accepts 100, "100", and "100%"', () => {
    assert.equal(isNeutralPitch(100), true);
    assert.equal(isNeutralPitch(100.0), true);
    assert.equal(isNeutralPitch('100'), true);
    assert.equal(isNeutralPitch(' 100 '), true);
    assert.equal(isNeutralPitch('100%'), true);
    assert.equal(isNeutralPitch('100.0%'), true);
    assert.equal(isNeutralPitch(50), false);
    assert.equal(isNeutralPitch('50%'), false);
    assert.equal(isNeutralPitch(99.5), false);
    assert.equal(isNeutralPitch(''), false);
    assert.equal(isNeutralPitch(null), false);
});

void test('strips numeric pitch 50', () => {
    const input = chart(`{
    "bpm": 120,
    "pitch": 50,
    "offset": 0
  }`);
    const result = stripNonDefaultPitchInLevelText(input);
    assert.equal(result.status, 'stripped');
    if (result.status !== 'stripped') return;
    assert.equal(result.removedValue, 50);
    assert.equal(result.text.includes('"pitch"'), false);
    assert.equal(result.text.includes('"bpm": 120'), true);
    assert.equal(result.text.includes('"offset": 0'), true);
    assert.equal(result.text.includes('"angleData": [0, 180]'), true);
});

void test('strips pitch 200', () => {
    const result = stripNonDefaultPitchInLevelText(chart(`{ "bpm": 90, "pitch": 200 }`));
    assert.equal(result.status, 'stripped');
    if (result.status !== 'stripped') return;
    assert.equal(result.removedValue, 200);
    assert.match(result.text, /"bpm": 90/);
    assert.equal(result.text.includes('pitch'), false);
});

void test('strips string pitch 50%', () => {
    const result = stripNonDefaultPitchInLevelText(chart(`{ bpm: 100, pitch: "50%" }`));
    assert.equal(result.status, 'stripped');
    if (result.status !== 'stripped') return;
    assert.equal(result.removedValue, '50%');
    assert.equal(/pitch/.test(result.text), false);
});

void test('strips pitch 99.5', () => {
    const result = stripNonDefaultPitchInLevelText(chart(`{ "pitch": 99.5, "bpm": 128 }`));
    assert.equal(result.status, 'stripped');
    if (result.status !== 'stripped') return;
    assert.equal(result.removedValue, 99.5);
    assert.match(result.text, /"bpm": 128/);
});

void test('keeps explicit numeric 100', () => {
    const input = chart(`{ "bpm": 120, "pitch": 100 }`);
    const result = stripNonDefaultPitchInLevelText(input);
    assert.equal(result.status, 'unchanged');
    assert.equal(input.includes('"pitch": 100'), true);
});

void test('keeps string 100 and 100%', () => {
    assert.equal(
        stripNonDefaultPitchInLevelText(chart(`{ "pitch": "100", "bpm": 1 }`)).status,
        'unchanged'
    );
    assert.equal(
        stripNonDefaultPitchInLevelText(chart(`{ "pitch": "100%", "bpm": 1 }`)).status,
        'unchanged'
    );
});

void test('keeps missing pitch', () => {
    const input = chart(`{ "bpm": 120, "offset": 0 }`);
    const result = stripNonDefaultPitchInLevelText(input);
    assert.equal(result.status, 'unchanged');
});

void test('does not strip pitch text inside decorations', () => {
    const input = chart(
        `{ "bpm": 120, "pitch": 50 }`,
        `,
  "decorations": [
    { "decorationImage": "pitch.png", "pitch": 50, "tag": "keep-me" }
  ]`
    );
    const result = stripNonDefaultPitchInLevelText(input);
    assert.equal(result.status, 'stripped');
    if (result.status !== 'stripped') return;
    assert.equal(result.text.includes('"decorationImage": "pitch.png"'), true);
    assert.equal(result.text.includes('"tag": "keep-me"'), true);
    assert.match(result.text, /"pitch": 50/);
    const settingsMatch = result.text.match(/"settings":\s*\{[\s\S]*?\}/);
    assert.ok(settingsMatch);
    assert.equal(settingsMatch[0].includes('pitch'), false);
});

void test('strips pitch from trailing-comma settings', () => {
    const result = stripNonDefaultPitchInLevelText(chart(`{ "bpm": 120, "pitch": 50, }`));
    assert.equal(result.status, 'stripped');
    if (result.status !== 'stripped') return;
    assert.equal(result.removedValue, 50);
    assert.match(result.text, /"bpm": 120/);
    const settingsMatch = result.text.match(/"settings":\s*\{[\s\S]*?\}/);
    assert.ok(settingsMatch);
    assert.equal(settingsMatch[0].includes('pitch'), false);
});

void test('strips last-property pitch without a trailing comma', () => {
    const result = stripNonDefaultPitchInLevelText(chart(`{ "bpm": 120, "pitch": 75 }`));
    assert.equal(result.status, 'stripped');
    if (result.status !== 'stripped') return;
    assert.equal(result.removedValue, 75);
    assert.match(result.text, /"bpm": 120\s*\}/);
});

void test('stripNonDefaultPitchFromSettingsRecord deletes non-neutral pitch', () => {
    const settings: Record<string, unknown> = {bpm: 120, pitch: 50};
    const result = stripNonDefaultPitchFromSettingsRecord(settings);
    assert.equal(result.changed, true);
    assert.equal(result.removedValue, 50);
    assert.equal('pitch' in settings, false);
    assert.equal(settings.bpm, 120);
});

void test('stripNonDefaultPitchFromSettingsRecord keeps 100', () => {
    const settings: Record<string, unknown> = {pitch: 100};
    const result = stripNonDefaultPitchFromSettingsRecord(settings);
    assert.equal(result.changed, false);
    assert.equal(settings.pitch, 100);
});
