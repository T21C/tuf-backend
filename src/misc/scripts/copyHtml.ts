import fs from 'fs';
import path from 'path';

const cwd = process.cwd();

// Source/dest from env; relative paths resolved from cwd
const srcDir = path.resolve(cwd, process.env.COPY_HTML_SRC ?? 'src');
const destDir = path.resolve(cwd, process.env.COPY_HTML_DEST ?? 'dist');

function copyHtmlFiles() {
  if (!fs.existsSync(srcDir)) {
    console.error(`copyHtml: source directory not found: ${srcDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(srcDir);
  const htmlFiles = files.filter((file) => file.endsWith('.html'));

  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  let count = 0;
  for (const file of htmlFiles) {
    const srcPath = path.join(srcDir, file);
    const destPath = path.join(destDir, file);
    fs.copyFileSync(srcPath, destPath);
    count++;
  }

  console.log(`Copied ${count} HTML file(s) to ${destDir}`);
}

copyHtmlFiles();

const bannerManifestSource = path.join(srcDir, 'config', 'bannerPresetManifest.json');
const bannerManifestDestination = path.join(destDir, 'config', 'bannerPresetManifest.json');
if (!fs.existsSync(bannerManifestSource)) {
  throw new Error(`copyHtml: banner preset manifest not found: ${bannerManifestSource}`);
}
fs.mkdirSync(path.dirname(bannerManifestDestination), { recursive: true });
fs.copyFileSync(bannerManifestSource, bannerManifestDestination);
console.log(`Copied banner preset manifest to ${bannerManifestDestination}`);
