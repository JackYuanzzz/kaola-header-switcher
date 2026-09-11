import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { writeIcons } from './icon.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const dist = new URL('../dist/', import.meta.url);
await mkdir(dist, { recursive: true });

// The ESM Rough.js bundle includes these MIT dependencies; ship their notices too.
const require = createRequire(import.meta.url);
const roughRequire = createRequire(require.resolve('roughjs/package.json'));
const notices = await Promise.all([
  'roughjs', 'hachure-fill', 'path-data-parser', 'points-on-curve', 'points-on-path',
].map(async (name) => {
  const manifestPath = roughRequire.resolve(`${name}/package.json`);
  const { version } = JSON.parse(await readFile(manifestPath, 'utf8'));
  const license = await readFile(join(dirname(manifestPath), 'LICENSE'), 'utf8');
  return `${name} ${version}\n${license}`;
}));

const shared = {
  absWorkingDir: project,
  bundle: true,
  platform: 'browser',
  target: 'chrome110',
  charset: 'utf8',
  legalComments: 'none',
  logLevel: 'info',
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ['src/background.ts', 'src/popup.ts'],
    outdir: 'dist',
    format: 'esm',
  }),
  build({
    ...shared,
    entryPoints: ['src/content.ts'],
    outfile: 'dist/content.js',
    format: 'iife',
  }),
  ...['manifest.json', 'popup.html', 'popup.css'].map((file) =>
    copyFile(new URL(`../public/${file}`, import.meta.url), new URL(file, dist)),
  ),
  writeIcons(new URL('icons/', dist)),
  writeFile(new URL('LICENSES.txt', dist), notices.join('\n\n---\n\n')),
]);

console.log(`扩展构建完成：${fileURLToPath(dist)}`);
