/** Local, idempotent fixtures for all non-empty common/platform URL combinations. */
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  if (process.env.NODE_ENV !== 'development' || process.env.DB_HOST !== '127.0.0.1'
    || process.env.DB_DATABASE !== 'tuf_web_test') throw new Error('Local test database required');
  await import('@/models/index.js');
  const {default: User} = await import('@/models/auth/User.js');
  const {default: Mod} = await import('@/models/misc/Mod.js');
  const {default: ModAssignee} = await import('@/models/misc/ModAssignee.js');
  const {createCatalogMod} = await import('@/server/services/mods/modCreate.js');
  const {latestModVersion} = await import('@/server/services/mods/modCatalog.js');
  const {updateReleaseFromParsed, createReleaseFromParsed} = await import('@/server/services/mods/modRelease.js');
  const {fetchGithubReleaseAssets, classifyGithubReleaseAssets, detectModZipPlatform} = await import('@/server/services/mods/modGithubAssets.js');
  const {indexCatalogMod} = await import('@/server/services/mods/modSearchIndex.js');
  const {invalidatePublicModsCache} = await import('@/server/services/mods/modCache.js');
  const user = await User.findOne({where: {username: 'modziptest'}});
  if (!user) throw new Error('Seed the test developer first');
  const commonRelease = await fetchGithubReleaseAssets('https://github.com/PizzaLovers007/AdofaiTweaks/releases/tag/v2.9.3');
  if (!commonRelease.downloadUrl) throw new Error('Expected one common ZIP asset');
  const helperGh = 'https://github.com/coyami-ke/TUFHelper/releases/tag/v3.1.1';
  const helperRelease = await fetchGithubReleaseAssets(helperGh);
  const platforms = ['windows', 'macos', 'linux'] as const;
  const urls = helperRelease.platformDownloadUrls;
  if (platforms.some(p => !urls[p])) throw new Error('Expected all three TUFHelper platform ZIPs');
  const common = commonRelease.downloadUrl;
  const created: {id: number; slug: string; name: string}[] = [];
  type Patch = Parameters<typeof updateReleaseFromParsed>[1];
  async function seed(key: string, label: string, description: string, patch: Patch) {
    const slug = `zip-case-${key}`;
    const name = `ZIP Case ${label}`;
    let mod = await Mod.findOne({where: {slug}});
    if (mod && mod.name !== name) throw new Error(`Fixture slug occupied: ${slug}`);
    if (!mod) {
      mod = await createCatalogMod({slug, name, creatorUsername: 'Local ZIP Cases', creatorDiscordId: '10001',
        version: 'case-1', description: `${description}\n\n로컬 URL 라우팅 테스트 데이터입니다. 통합 ZIP은 AdofaiTweaks v2.9.3, 플랫폼별 ZIP은 TUFHelper v3.1.1을 사용하므로 실제 설치 호환성을 나타내는 모드 묶음이 아닙니다.`,
        downloadUrl: common, imageUrl: null, projectUrl: helperGh,
        deprecatedAfter: null, sourceUploadedAt: new Date(), hidden: false, isPinned: false});
      const release = await latestModVersion(mod.id);
      if (!release) throw new Error('Missing fixture release');
      await updateReleaseFromParsed(release, {...patch, notes: description});
    }
    await ModAssignee.findOrCreate({where: {modId: mod.id, userId: user!.id}, defaults: {modId: mod.id, userId: user!.id}});
    await indexCatalogMod(mod.id);
    created.push({id: mod.id, slug, name});
    return mod;
  }
  for (let mask = 1; mask < 16; mask++) {
    const hasCommon = !!(mask & 8);
    const platformDownloadUrls: NonNullable<Patch['platformDownloadUrls']> = {};
    platforms.forEach((p, i) => {if (mask & (1 << i)) platformDownloadUrls[p] = urls[p];});
    const selected = platforms.filter(p => platformDownloadUrls[p]);
    const label = `${String(mask).padStart(2, '0')} — ${[hasCommon ? 'Common' : '', ...selected].filter(Boolean).join(' + ')}`;
    const description = `통합 ZIP: ${hasCommon ? '있음' : '없음'} / 플랫폼 ZIP: ${selected.join(', ') || '없음'}. 플랫폼 URL이 있으면 우선 사용하고, 없으면 통합 URL로 대체합니다. 통합 URL도 없으면 미지원 플랫폼은 404, 플랫폼 미지정 요청은 400입니다.`;
    await seed(`matrix-${String(mask).padStart(2, '0')}`, label, description,
      {downloadUrl: hasCommon ? common : '', githubUrl: null, platformDownloadUrls: selected.length ? platformDownloadUrls : null});
  }
  await seed('gh-common', '16 — GH common auto', 'GitHub 태그 URL만으로 단일 통합 ZIP을 자동 추출합니다.',
    {githubUrl: 'https://github.com/PizzaLovers007/AdofaiTweaks/releases/tag/v2.9.3'});
  for (const [key, url] of Object.entries({tag: helperGh, repo: 'https://github.com/coyami-ke/TUFHelper', latest: 'https://github.com/coyami-ke/TUFHelper/releases/latest', asset: urls.windows!})) {
    await seed(`gh-${key}`, `GH ${key} auto`, `GitHub ${key} URL 입력 사례. tag/repo/latest는 릴리즈 assets를 분류하고, asset URL은 지정한 파일 하나를 그대로 사용합니다. repo/latest는 실행 당시 최신 릴리즈를 저장하며 이후 자동 갱신하지 않습니다.`, {githubUrl: url});
  }
  const older = await fetchGithubReleaseAssets('https://github.com/coyami-ke/TUFHelper/releases/tag/v3.1.0');
  await seed('mixed-versions', 'OS release versions', 'Windows는 3.1.1, macOS·Linux는 3.1.0 ZIP입니다. URL별 실제 릴리즈 버전이 달라도 저장할 수 있습니다. TUF 릴리즈 표시 버전은 하나의 공통 메타데이터입니다.',
    {downloadUrl: '', githubUrl: helperGh, platformDownloadUrls: {windows: urls.windows, macos: older.platformDownloadUrls.macos, linux: older.platformDownloadUrls.linux}});
  const history = await seed('history', 'Release history', '최신 case-1은 플랫폼별 ZIP, 이전 case-0은 통합 ZIP입니다. 최신 링크와 버전 고정 링크를 비교하세요.',
    {downloadUrl: '', githubUrl: helperGh, platformDownloadUrls: urls});
  const {default: ModVersion} = await import('@/models/misc/ModVersion.js');
  if (!await ModVersion.findOne({where: {modId: history.id, version: 'case-0'}})) {
    await createReleaseFromParsed(history.id, {version: 'case-0', releasedAt: new Date('2025-01-01T00:00:00Z'), downloadUrl: common, platformDownloadUrls: null, notes: '이전 통합 ZIP 릴리즈'});
    await indexCatalogMod(history.id);
  }
  const names = ['Mod.Windows.zip', 'Mod.win64.zip', 'Mod.OSX.zip', 'Mod.Darwin.zip', 'Mod.Ubuntu.zip', 'Mod.zip', 'Mod-linux-windows.zip', 'Mod.windows.debug.zip', 'Mod.symbols.zip', 'Mod.windowsx64.zip', 'ModWindows.zip'];
  const classifications = names.map(name => `${name} → ${detectModZipPlatform(name) ?? '자동 추천 제외'}`);
  const ambiguous = classifyGithubReleaseAssets({assets: ['Mod.win32.zip', 'Mod.win64.zip'].map(name => ({name, browser_download_url: `https://github.com/coyami-ke/TUFHelper/releases/download/fixture/${name}`}))});
  if (ambiguous.platformDownloadUrls.windows) throw new Error('Ambiguous assets must not be auto-selected');
  await seed('detection-rules', 'Filename detection rules', `파일명 판별 예시 (실제 다운로드 후보가 아닌 설명용 이름):\n${classifications.join('\n')}\n동일 OS의 win32/win64 두 ZIP은 자동 선택하지 않고 수동 선택합니다. .tar.gz와 GitHub 자동 Source code ZIP은 수집하지 않습니다. ZIP 내부 파일이나 실제 실행 호환성을 분석하지 않습니다.`,
    {downloadUrl: common, githubUrl: null, platformDownloadUrls: null});
  await invalidatePublicModsCache();
  console.log(JSON.stringify({assignedTo: user.username, count: created.length, cases: created}));
  process.exit(0);
}
main().catch(error => {console.error((error as Error).message); process.exit(1);});
