import assert from 'node:assert/strict';
import test from 'node:test';

import {
    resolveSevenZipThreadCount,
    sevenZipThreadArg,
    withSevenZipThreadLimit,
} from './sevenZipCpuClamp.js';

void test('seven-zip thread count defaults to 2', () => {
    assert.equal(resolveSevenZipThreadCount({}), 2);
    assert.equal(sevenZipThreadArg({}), '-mmt=2');
});

void test('seven-zip thread count reads CDN_7Z_THREADS and caps at 8', () => {
    assert.equal(resolveSevenZipThreadCount({CDN_7Z_THREADS: '1'}), 1);
    assert.equal(resolveSevenZipThreadCount({CDN_7Z_THREADS: '99'}), 8);
    assert.equal(resolveSevenZipThreadCount({CDN_7Z_THREADS: '0'}), 2);
    assert.equal(resolveSevenZipThreadCount({CDN_7Z_THREADS: 'nope'}), 2);
});

void test('withSevenZipThreadLimit inserts -mmt after the command verb', () => {
    assert.deepEqual(
        withSevenZipThreadLimit(['x', 'archive.zip', '-o/tmp', '-y'], {}),
        ['x', '-mmt=2', 'archive.zip', '-o/tmp', '-y'],
    );
    assert.deepEqual(
        withSevenZipThreadLimit(['a', '-tzip', 'out.zip', '*'], {CDN_7Z_THREADS: '1'}),
        ['a', '-mmt=1', '-tzip', 'out.zip', '*'],
    );
});

void test('withSevenZipThreadLimit does not duplicate an existing -mmt switch', () => {
    assert.deepEqual(
        withSevenZipThreadLimit(['x', '-mmt=4', 'archive.zip'], {}),
        ['x', '-mmt=4', 'archive.zip'],
    );
    assert.deepEqual(
        withSevenZipThreadLimit(['x', '-mmt2', 'archive.zip'], {}),
        ['x', '-mmt2', 'archive.zip'],
    );
});
