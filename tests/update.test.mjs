import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const updater = new URL('../scripts/update.sh', import.meta.url).pathname;
const files = [
    'manifest.json', 'background.js', 'popup.js', 'content.js', 'popup.html', 'popup.css',
    'LICENSES.txt', 'update.sh', 'icons/icon-16.png', 'icons/icon-32.png',
    'icons/icon-48.png', 'icons/icon-128.png',
];

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'kaola-update-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const install = join(root, 'installed-extension');
    const source = join(root, 'new-package');
    const archive = join(root, 'update.zip');
    await mkdir(install);
    await mkdir(join(source, 'icons'), { recursive: true });
    await writeFile(join(install, 'manifest.json'), JSON.stringify({ name: '有问题找kaola', version: '1.0.1' }));
    await writeFile(join(install, 'background.js'), 'old background');
    await writeFile(join(root, 'browser-rules.json'), 'untouched rule storage');
    for (const file of files) {
        const content = file === 'manifest.json'
            ? JSON.stringify({ name: '有问题找kaola', version: '1.0.2' })
            : `new ${file}`;
        await writeFile(join(source, file), content);
    }
    execFileSync('zip', ['-q', archive, ...files], { cwd: source });
    const sha = createHash('sha256').update(await readFile(archive)).digest('hex');
    const run = (...extra) => spawnSync('sh', [updater, '--install-dir', install, '--archive', archive, '--sha256', sha, ...extra], { encoding: 'utf8' });
    return { root, install, archive, sha, run };
}

test('updater validates locally without modifying the installed extension', async (t) => {
    const { install, run } = await fixture(t);
    const result = run('--dry-run');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1\.0\.1 → 1\.0\.2/);
    assert.match(result.stdout, /未修改原安装/);
    assert.match(await readFile(join(install, 'background.js'), 'utf8'), /old background/);
});

test('updater replaces the same path, keeps a backup, and leaves other data alone', async (t) => {
    const { root, install, run } = await fixture(t);
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(join(install, 'manifest.json'), 'utf8')).version, '1.0.2');
    assert.equal(await readFile(join(install, 'background.js'), 'utf8'), 'new background.js');
    assert.equal(await readFile(join(root, 'browser-rules.json'), 'utf8'), 'untouched rule storage');
    const [work] = (await readdir(root)).filter(name => name.startsWith('.kaola-update.'));
    assert.ok(work);
    assert.equal(await readFile(join(root, work, 'previous-1.0.1', 'background.js'), 'utf8'), 'old background');
    assert.equal(run().status, 1, 'same-version package must not be installed again');
});

test('an updater inside the installed directory can use that directory automatically', async (t) => {
    const { install, archive, sha } = await fixture(t);
    await writeFile(join(install, 'update.sh'), await readFile(updater));
    const result = spawnSync('sh', [join(install, 'update.sh'), '--archive', archive, '--sha256', sha], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(join(install, 'manifest.json'), 'utf8')).version, '1.0.2');
});

test('updater rejects a wrong checksum and a symlink target before replacing files', async (t) => {
    const { root, install, archive, run } = await fixture(t);
    const bad = spawnSync('sh', [updater, '--install-dir', install, '--archive', archive, '--sha256', '0'.repeat(64)], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /SHA-256 不匹配/);
    assert.equal(await readFile(join(install, 'background.js'), 'utf8'), 'old background');
    const link = join(root, 'link');
    await symlink(install, link);
    const unsafe = spawnSync('sh', [updater, '--install-dir', link, '--archive', archive, '--sha256', '0'.repeat(64)], { encoding: 'utf8' });
    assert.equal(unsafe.status, 1);
    assert.match(unsafe.stderr, /符号链接/);
    assert.equal(await readFile(join(install, 'background.js'), 'utf8'), 'old background');
    assert.equal(run('--dry-run').status, 0);
});
