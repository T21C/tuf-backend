/** Creates one local development fixture for feat/mod-zip-url. */
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const host = process.env.DB_HOST;
  const database = process.env.DB_DATABASE ?? '';
  if (process.env.NODE_ENV !== 'development' || !['localhost', '127.0.0.1', '::1'].includes(host ?? '')
    || !/(?:_test|_dev)$/.test(database)) {
    throw new Error('This fixture can only be seeded into a local development/test database');
  }
  // Register associations before catalog serialization and indexing.
  await import('@/models/index.js');
  const {default: Mod} = await import('@/models/misc/Mod.js');
  const {createCatalogMod} = await import('@/server/services/mods/modCreate.js');
  const {latestModVersion} = await import('@/server/services/mods/modCatalog.js');
  const {updateReleaseFromParsed} = await import('@/server/services/mods/modRelease.js');
  const {indexCatalogMod} = await import('@/server/services/mods/modSearchIndex.js');
  const {getSequelizeForModelGroup} = await import('@/config/db.js');
  const sequelize = getSequelizeForModelGroup('admin');
  await sequelize.authenticate();
  const slug = 'mod-zip-url-test';
  const existing = await Mod.findOne({where: {slug}});
  if (existing && existing.name !== 'ZIP URL Test — TUFHelper') {
    throw new Error('The test slug is already occupied by another mod');
  }
  const now = new Date();
  const mod = existing ?? await createCatalogMod({
    slug,
    name: 'ZIP URL Test — TUFHelper',
    creatorUsername: 'Local Development Test',
    creatorDiscordId: '10000',
    version: '3.1.1',
    description: '로컬 개발용 ZIP URL 테스트 모드입니다. 릴리즈 편집에서 플랫폼별 ZIP URL과 GitHub ZIP 자동 추출을 확인할 수 있습니다. 첨부 ZIP은 TUFHelper v3.1.1 공개 릴리즈입니다.',
    downloadUrl: '',
    imageUrl: null,
    projectUrl: 'https://github.com/coyami-ke/TUFHelper',
    deprecatedAfter: null,
    sourceUploadedAt: now,
    hidden: false,
    isPinned: true,
  });
  const release = await latestModVersion(mod.id);
  if (!release) throw new Error('Test mod release was not created');
  if (!existing || !release.platformDownloadUrls) {
    await updateReleaseFromParsed(release, {
      githubUrl: 'https://github.com/coyami-ke/TUFHelper/releases/tag/v3.1.1',
      downloadUrl: '',
      platformDownloadUrls: {
        windows: 'https://github.com/coyami-ke/TUFHelper/releases/download/v3.1.1/TUFHelper.Windows.3.1.1.zip',
        macos: 'https://github.com/coyami-ke/TUFHelper/releases/download/v3.1.1/TUFHelper.OSX.3.1.1.zip',
        linux: 'https://github.com/coyami-ke/TUFHelper/releases/download/v3.1.1/TUFHelper.Linux.3.1.1.zip',
      },
      notes: 'Windows / macOS / Linux ZIP URL 및 GitHub 릴리즈 자동 추출 테스트',
    });
  }
  await indexCatalogMod(mod.id);
  console.log(JSON.stringify({id: mod.id, slug, version: release.version, database}));
  process.exit(0);
}

main().catch((error) => {
  console.error('Test mod seed failed:', (error as Error).message);
  process.exit(1);
});
