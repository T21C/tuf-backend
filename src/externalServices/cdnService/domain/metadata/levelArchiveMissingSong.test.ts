import assert from 'node:assert/strict';
import test from 'node:test';

import { levelArchiveMissingSong } from './levelArchiveMissingSong.js';

const target = {
    name: 'level.adofai',
    relativePath: 'level.adofai',
    songFilename: '',
    hasYouTubeStream: false,
};

void test('bundled song file suppresses the warning', () => {
    const missing = levelArchiveMissingSong({
        allLevelFiles: [target],
        targetLevelRelativePath: 'level.adofai',
        songFiles: { 'song.ogg': { name: 'song.ogg' } },
    });
    assert.equal(missing, false);
});

void test('no song and no ysmod is missing', () => {
    const missing = levelArchiveMissingSong({
        allLevelFiles: [target],
        targetLevelRelativePath: 'level.adofai',
    });
    assert.equal(missing, true);
});

void test('ysmod without a link is missing', () => {
    const missing = levelArchiveMissingSong({
        allLevelFiles: [{ ...target, hasYouTubeStream: true, songFilename: 'song.ogg' }],
        targetLevelRelativePath: 'level.adofai',
    });
    assert.equal(missing, true);
});

void test('ysmod with songURL is not missing', () => {
    const missing = levelArchiveMissingSong(
        {
            allLevelFiles: [{ ...target, hasYouTubeStream: false }],
            targetLevelRelativePath: 'level.adofai',
        },
        JSON.stringify({
            settings: {
                requiredMods: ['YouTubeStream'],
                songURL: 'https://www.youtube.com/watch?v=abc',
            },
        })
    );
    assert.equal(missing, false);
});

void test('ysmod with a youtube link in songFilename is not missing', () => {
    const missing = levelArchiveMissingSong({
        allLevelFiles: [{
            ...target,
            hasYouTubeStream: true,
            songFilename: 'https://youtu.be/abc',
        }],
        targetLevelRelativePath: 'level.adofai',
    });
    assert.equal(missing, false);
});

void test('a link without ysmod is still missing', () => {
    const missing = levelArchiveMissingSong(
        {
            allLevelFiles: [target],
            targetLevelRelativePath: 'level.adofai',
        },
        JSON.stringify({
            settings: { songURL: 'https://www.youtube.com/watch?v=abc' },
        })
    );
    assert.equal(missing, true);
});
