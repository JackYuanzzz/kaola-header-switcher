import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const manifest = JSON.parse(await readFile(new URL('../dist/manifest.json', import.meta.url), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('扩展版本号格式无效。');
const archive = `lane-header-switcher-${manifest.version}.zip`;

// -FS synchronizes this named archive with these exact build outputs, dropping stale entries.
execFileSync('zip', [
  '-q', '-FS', `../${archive}`,
  'manifest.json', 'background.js', 'popup.js', 'content.js', 'popup.html', 'popup.css', 'LICENSES.txt',
  'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png',
], { cwd: fileURLToPath(new URL('../dist/', import.meta.url)), stdio: 'inherit' });
console.log(`安装包已生成：${fileURLToPath(new URL(`../${archive}`, import.meta.url))}`);
