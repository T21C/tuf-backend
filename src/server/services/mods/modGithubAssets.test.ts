import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';
import {classifyGithubReleaseAssets, detectModZipPlatform, fetchGithubReleaseAssets, githubReleaseApiUrl} from './modGithubAssets.js';
import {parseModPlatform, selectModDownloadUrl} from './modPlatformDownloads.js';

const asset = (name: string) => ({name, browser_download_url: `https://github.com/org/mod/releases/download/v1/${name}`, size: 1024});

void test('GitHub release URLs resolve tagged, latest and encoded tag API endpoints', () => {
  for (const suffix of ['', '/releases', '/releases/latest']) {
    assert.equal(githubReleaseApiUrl(`https://github.com/org/mod${suffix}`), 'https://api.github.com/repos/org/mod/releases/latest');
  }
  assert.equal(githubReleaseApiUrl('https://github.com/org/mod/releases/tag/v1'), 'https://api.github.com/repos/org/mod/releases/tags/v1');
  assert.equal(githubReleaseApiUrl('https://github.com/org/mod/releases/download/v1/mod.zip'), 'https://api.github.com/repos/org/mod/releases/tags/v1');
  assert.equal(githubReleaseApiUrl('https://github.com/org/mod/releases/tag/release%2Fv1'), 'https://api.github.com/repos/org/mod/releases/tags/release%2Fv1');
  for (const url of ['https://evil.com/org/mod', 'http://github.com/org/mod', 'https://u:p@github.com/org/mod', 'https://github.com/org/mod/issues', 'https://github.com/org/mod/releases/tag/%zz']) {
    assert.throws(() => githubReleaseApiUrl(url));
  }
});

void test('platform heuristics detect common mod naming conventions and exclude ambiguous or source ZIPs', () => {
  for (const [name, platform] of [
    ['TUFHelper.Windows.3.1.zip', 'windows'], ['Mod-win64.zip', 'windows'],
    ['TUFHelper.OSX.3.1.zip', 'macos'], ['Mod-macos-arm64.zip', 'macos'],
    ['ModDarwin.zip', 'macos'], ['Mod.Linux.zip', 'linux'], ['Mod-ubuntu.zip', 'linux'],
    ['Mod.zip', 'common'], ['Darwinian.zip', 'common'], ['Mod-win-linux.zip', null],
    ['Mod-source.zip', null], ['Mod-symbols.zip', null],
  ] as const) assert.equal(detectModZipPlatform(name), platform, name);
});

void test('ZIP discovery suggests one asset per platform and leaves multiple candidates unselected', () => {
  const result = classifyGithubReleaseAssets({tag_name: 'v1', html_url: 'https://github.com/org/mod/releases/tag/v1', assets: [
    asset('Mod.Windows.zip'), asset('Mod.OSX.zip'), asset('Mod.Linux.zip'), asset('Mod.zip'), asset('Mod-source.zip'),
    asset('Mod.tar.gz'), {name: 'bad.zip', browser_download_url: 'https://evil.com/a.zip'},
  ]});
  assert.equal(result.assets.length, 5);
  assert.equal(result.downloadUrl, asset('Mod.zip').browser_download_url);
  assert.deepEqual(result.platformDownloadUrls, {windows: asset('Mod.Windows.zip').browser_download_url,
    macos: asset('Mod.OSX.zip').browser_download_url, linux: asset('Mod.Linux.zip').browser_download_url});
  const ambiguous = classifyGithubReleaseAssets({assets: [asset('Mod-win-x64.zip'), asset('Mod-win-arm64.zip'), asset('one.zip'), asset('two.zip')]});
  assert.deepEqual(ambiguous.platformDownloadUrls, {});
  assert.equal(ambiguous.downloadUrl, '');
  assert.equal(ambiguous.assets.length, 4);
});

void test('GitHub discovery fetches only the fixed API host and reports an empty release', async (t) => {
  const get = t.mock.method(axios, 'get', async (url: string) => {
    assert.equal(url, 'https://api.github.com/repos/org/mod/releases/tags/v1');
    return {data: {assets: [asset('Mod.OSX.zip')]}};
  });
  const result = await fetchGithubReleaseAssets('https://github.com/org/mod/releases/tag/v1');
  assert.equal(result.platformDownloadUrls.macos, asset('Mod.OSX.zip').browser_download_url);
  get.mock.mockImplementation(async () => ({data: {assets: []}}));
  await assert.rejects(fetchGithubReleaseAssets('https://github.com/org/mod/releases/tag/v1'), /no ZIP assets/);
});

void test('platform download selection prefers the platform ZIP, falls back to common, and never chooses another OS', () => {
  const release = {downloadUrl: 'common.zip', platformDownloadUrls: {windows: 'win.zip', macos: 'mac.zip'}};
  assert.equal(selectModDownloadUrl(release, 'macos'), 'mac.zip');
  assert.equal(selectModDownloadUrl(release, 'linux'), 'common.zip');
  assert.equal(selectModDownloadUrl(release), 'common.zip');
  const platformOnly = {...release, downloadUrl: ''};
  assert.equal(selectModDownloadUrl(platformOnly, 'linux'), null);
  assert.equal(selectModDownloadUrl(platformOnly), null);
  assert.equal(parseModPlatform('darwin'), 'macos');
  assert.equal(parseModPlatform('Win32'), 'windows');
  assert.equal(parseModPlatform('android'), null);
  assert.equal(parseModPlatform(['windows']), null);
});
