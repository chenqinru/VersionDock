import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// --desktop points to an independently checked-out Desktop project. Only the
// public test process and on-disk storage are shared; no counterpart code import.
const desktopArg = process.argv.indexOf('--desktop');
const desktop = desktopArg < 0 ? undefined : path.resolve(process.argv[desktopArg + 1]);
const require = createRequire(import.meta.url);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'versiondock-shelf-test-'));
fs.writeFileSync(path.join(base, 'shelf-test-fixture'), 'temporary integration fixture');
const bundle = await build({ entryPoints: [path.join(project, 'src/host/git/ShelveService.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vscode', 'simple-git'] });
const module = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: id => id === 'vscode' ? { l10n: { t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, i) => args[Number(i)]) } } : require(id), process, Buffer, console, setTimeout, clearTimeout });
const { ShelveService } = module.exports;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let passed = 0;
function fixture(name) {
  let root = path.join(base, name);
  fs.mkdirSync(root);
  root = fs.realpathSync(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Shelf Test');
  git(root, 'config', 'user.email', 'shelf@example.test');
  git(root, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, 'file.txt'), 'original\n');
  fs.writeFileSync(path.join(root, 'tracked.bin'), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(root, 'legacy.txt'), Buffer.from([0xfe, 0x61, 0x0a]));
  if (process.platform !== 'win32') fs.symlinkSync('old-target', path.join(root, 'tracked-link'));
  git(root, 'add', '.'); git(root, 'commit', '-m', 'initial');
  const globalStorage = path.join(base, `${name}-plugin`);
  const config = path.join(base, `${name}-app`);
  const shared = path.join(root, '.git/versiondock/shelves');
  const service = new ShelveService(root, globalStorage);
  return { root, config, shared, globalStorage, service, second: new ShelveService(root, path.join(base, `${name}-other-ide`)) };
}
function prepareChanges(f) {
  fs.writeFileSync(path.join(f.root, 'file.txt'), 'changed\n');
  fs.writeFileSync(path.join(f.root, 'legacy.txt'), Buffer.from([0xff, 0x62, 0x0a]));
  fs.writeFileSync(path.join(f.root, 'tracked.bin'), Buffer.from([0, 254, 1, 255]));
  fs.writeFileSync(path.join(f.root, 'new.bin'), Buffer.from([0, 255, 128, 3]));
  fs.writeFileSync(path.join(f.root, 'new.txt'), '新文本\n');
  fs.writeFileSync(path.join(f.root, 'executable.bin'), Buffer.from([0, 99]));
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(f.root, 'executable.bin'), 0o755);
    fs.symlinkSync(Buffer.from([116, 97, 114, 103, 101, 116, 10, 255]), path.join(f.root, 'link'));
    fs.unlinkSync(path.join(f.root, 'tracked-link'));
    fs.symlinkSync(Buffer.from([0xff, 0x78, 0x0a]), path.join(f.root, 'tracked-link'));
  }
}
function assertRestored(f) {
  assert.equal(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8'), 'changed\n');
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'legacy.txt')), Buffer.from([0xff, 0x62, 0x0a]));
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'tracked.bin')), Buffer.from([0, 254, 1, 255]));
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'new.bin')), Buffer.from([0, 255, 128, 3]));
  assert.equal(fs.readFileSync(path.join(f.root, 'new.txt'), 'utf8'), '新文本\n');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(f.root, 'executable.bin')).mode & 0o777, 0o755);
    assert.deepEqual(fs.readlinkSync(path.join(f.root, 'tracked-link'), { encoding: 'buffer' }), Buffer.from([0xff, 0x78, 0x0a]));
    assert.deepEqual(fs.readlinkSync(path.join(f.root, 'link'), { encoding: 'buffer' }), Buffer.from([116, 97, 114, 103, 101, 116, 10, 255]));
  }
}
const test = async (name, run) => { await run(); passed++; console.log(`PASS ${name}`); };
async function app(f, request, expectError = false) {
  const payload = { root: f.root, config: f.config, ...request };
  const output = await new Promise((resolve, reject) => {
    const child = spawn('cargo', ['test', '--locked', '--manifest-path', path.join(desktop, 'src-tauri/Cargo.toml'), 'integration_tests::shelf_interop_driver', '--', '--ignored', '--exact', '--nocapture'], { cwd: desktop, env: { ...process.env, VERSIONDOCK_SHELF_TEST_REQUEST: JSON.stringify(payload) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`${stdout}\n${stderr}`)));
  });
  const match = output.match(/^SHELF_TEST_RESULT:(.+)$/m);
  assert.ok(match, output);
  const result = JSON.parse(match[1]);
  if (expectError) { assert.ok(result.error, output); return result.error; }
  assert.ok('ok' in result, JSON.stringify(result.error));
  return result.ok;
}
try {
  await test('two IDE stores share create, rename, attachment restore and deletion', async () => {
    const f = fixture('plugin'); prepareChanges(f);
    const entry = await f.service.push('from plugin');
    assert.equal((await f.second.list())[0].id, entry.id);
    await f.second.rename(entry.id, 'renamed');
    assert.equal((await f.service.list())[0].name, 'renamed');
    await f.second.apply(entry.id); assertRestored(f);
    await f.service.drop(entry.id); assert.equal((await f.second.list()).length, 0);
    assert.deepEqual(fs.readdirSync(f.shared), ['shelves.json']);
  });
  await test('legacy shelves migrate attachments once and deletion never reimports', async () => {
    const f = fixture('legacy');
    const legacy = path.join(f.globalStorage, 'shelves', crypto.createHash('sha1').update(f.root).digest('hex').slice(0, 16));
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'old.patch'), '');
    fs.writeFileSync(path.join(legacy, 'old.bin'), Buffer.from([0, 255, 9]));
    fs.writeFileSync(path.join(legacy, 'shelves.json'), JSON.stringify({ shelves: [{ id: 'shelf-legacy', name: 'legacy', date: '2026-10-09T00:00:00Z', files: [{ path: 'legacy.bin', status: 'untracked' }], patchFile: 'old.patch', binaryFiles: [{ repoRelPath: 'legacy.bin', storeName: 'old.bin', mode: 0o755 }] }] }));
    const entry = (await f.service.list())[0];
    await f.second.apply(entry.id);
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'legacy.bin')), Buffer.from([0, 255, 9]));
    await f.second.drop(entry.id);
    assert.equal((await new ShelveService(f.root, f.globalStorage).list()).length, 0);
    assert.ok(fs.existsSync(path.join(legacy, 'shelves.json')));
  });
  await test('concurrent metadata writers retain both changes', async () => {
    const f = fixture('concurrent');
    fs.writeFileSync(path.join(f.root, 'file.txt'), 'first\n'); const a = await f.service.push('a');
    fs.writeFileSync(path.join(f.root, 'file.txt'), 'second\n'); const b = await f.service.push('b');
    await Promise.all([f.service.rename(a.id, 'A'), f.second.rename(b.id, 'B')]);
    assert.deepEqual(new Set((await f.service.list()).map(e => e.name)), new Set(['A', 'B']));
  });
  await test('partial restore treats glob characters literally and restores empty/mode-only patches', async () => {
    const f = fixture('partial');
    fs.writeFileSync(path.join(f.root, '[x].txt'), 'selected\n');
    fs.writeFileSync(path.join(f.root, 'x.txt'), 'not selected\n');
    fs.writeFileSync(path.join(f.root, 'empty.txt'), '');
    const entry = await f.service.push('partial');
    await f.service.apply(entry.id, ['[x].txt', 'empty.txt']);
    assert.equal(fs.readFileSync(path.join(f.root, '[x].txt'), 'utf8'), 'selected\n');
    assert.equal(fs.readFileSync(path.join(f.root, 'empty.txt')).length, 0);
    assert.equal(fs.existsSync(path.join(f.root, 'x.txt')), false);
  });
  await test('existing destinations fail before applying tracked patches', async () => {
    const f = fixture('guard'); prepareChanges(f); const entry = await f.service.push('guard');
    fs.writeFileSync(path.join(f.root, 'new.bin'), 'keep existing');
    await assert.rejects(f.second.apply(entry.id), /Destination already exists/);
    assert.equal(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8'), 'original\n');
    assert.equal(fs.readFileSync(path.join(f.root, 'new.bin'), 'utf8'), 'keep existing');
  });
  await test('corrupt metadata and unsafe attachment paths fail without deleting records', async () => {
    const f = fixture('unsafe'); prepareChanges(f); const entry = await f.service.push('guard');
    const metaPath = path.join(f.shared, 'shelves.json'); const meta = JSON.parse(fs.readFileSync(metaPath));
    meta.shelves[0].binaryFiles[0].repoRelPath = '../escape'; fs.writeFileSync(metaPath, JSON.stringify(meta));
    await assert.rejects(f.service.apply(entry.id), /storage root/);
    assert.equal(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8'), 'original\n');
    fs.writeFileSync(metaPath, '{broken'); const before = fs.readFileSync(metaPath);
    await assert.rejects(f.second.list()); assert.deepEqual(fs.readFileSync(metaPath), before);
  });
  if (process.platform !== 'win32') await test('symlink destination parents cannot escape the repository', async () => {
    const f = fixture('symlink-parent'); fs.mkdirSync(path.join(f.root, 'nested')); fs.writeFileSync(path.join(f.root, 'nested/new.bin'), Buffer.from([0, 255]));
    const entry = await f.service.push('nested'); fs.rmdirSync(path.join(f.root, 'nested'));
    const outside = path.join(base, 'outside'); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(f.root, 'nested'));
    await assert.rejects(f.service.apply(entry.id), /Symbolic link/); assert.deepEqual(fs.readdirSync(outside), []);
  });
  await test('linked worktrees and separate clones keep independent shelves', async () => {
    const f = fixture('isolation'); fs.writeFileSync(path.join(f.root, 'file.txt'), 'saved\n'); await f.service.push('main');
    const worktree = path.join(base, 'linked'); git(f.root, 'worktree', 'add', '-b', 'linked', worktree);
    assert.equal((await new ShelveService(worktree, f.globalStorage).list()).length, 0);
    const clone = path.join(base, 'clone'); git(base, 'clone', f.root, clone);
    assert.equal((await new ShelveService(clone, f.globalStorage).list()).length, 0);
  });
  if (desktop) {
    await test('plugin create → Rust list/diff/partial/full restore → Rust drop → plugin empty', async () => {
      const f = fixture('to-app'); prepareChanges(f); const entry = await f.service.push('plugin to app');
      const entries = await app(f, { action: 'list' }); assert.equal(entries[0].id, entry.id); assert.equal(entries[0].createdAt, entry.date);
      assert.equal((await app(f, { action: 'diff', id: entry.id, path: 'new.bin' })).binary, true);
      await app(f, { action: 'operate', operation: { type: 'apply', shelf_id: entry.id, paths: ['new.bin'] } });
      assert.deepEqual(fs.readFileSync(path.join(f.root, 'new.bin')), Buffer.from([0, 255, 128, 3]));
      assert.equal(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8'), 'original\n');
      fs.unlinkSync(path.join(f.root, 'new.bin'));
      await app(f, { action: 'operate', operation: { type: 'apply', shelf_id: entry.id } }); assertRestored(f);
      await app(f, { action: 'operate', operation: { type: 'drop', shelf_id: entry.id } });
      assert.equal((await f.service.list()).length, 0); assert.deepEqual(fs.readdirSync(f.shared), ['shelves.json']);
    });
    await test('Rust create → plugin list/diff/restore/drop → Rust empty', async () => {
      const f = fixture('to-plugin'); prepareChanges(f);
      await app(f, { action: 'operate', operation: { type: 'create', name: 'app to plugin', paths: [] } });
      const entry = (await f.service.list())[0]; assert.equal(entry.name, 'app to plugin'); assert.ok(entry.date); assert.ok(entry.patchFile);
      assert.match(await f.service.getFileDiff(entry.id, 'file.txt'), /\+changed/);
      if (process.platform !== 'win32') {
        await f.service.apply(entry.id, ['link', 'legacy.txt']);
        assert.deepEqual(fs.readFileSync(path.join(f.root, 'legacy.txt')), Buffer.from([0xff, 0x62, 0x0a]));
        git(f.root, 'restore', '--source=HEAD', '--staged', '--worktree', '--', 'legacy.txt');
        assert.deepEqual(fs.readlinkSync(path.join(f.root, 'link'), { encoding: 'buffer' }), Buffer.from([116, 97, 114, 103, 101, 116, 10, 255]));
        git(f.root, 'reset', 'HEAD', '--', 'link'); fs.unlinkSync(path.join(f.root, 'link'));
      }
      await f.service.apply(entry.id); assertRestored(f);
      await f.service.drop(entry.id); assert.equal((await app(f, { action: 'list' })).length, 0);
    });
    await test('Rust restores a plugin shelf containing only independent binary attachments', async () => {
      const f = fixture('binary-only'); fs.writeFileSync(path.join(f.root, 'only.bin'), Buffer.from([0, 255, 7]));
      const entry = await f.service.push('binary only');
      await app(f, { action: 'operate', operation: { type: 'apply', shelf_id: entry.id } });
      assert.deepEqual(fs.readFileSync(path.join(f.root, 'only.bin')), Buffer.from([0, 255, 7]));
    });
    await test('Rust migration merges into nonempty shared list and preserves attachments across write', async () => {
      const f = fixture('app-migration'); prepareChanges(f); const plugin = await f.service.push('plugin backup');
      const repoId = `git-${crypto.createHash('sha256').update(`${f.root}::Git`).digest('hex').slice(0, 16)}`;
      const legacy = path.join(f.config, 'shelves', repoId); fs.mkdirSync(legacy, { recursive: true });
      fs.writeFileSync(path.join(legacy, 'shelf-app-old.patch'), 'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-original\n+old\n');
      fs.writeFileSync(path.join(legacy, 'index.json'), JSON.stringify({ shelves: [{ id: 'shelf-app-old', name: 'old app', createdAt: '2026-01-01', files: ['file.txt'], patchFile: null }] }));
      assert.equal((await app(f, { action: 'list' })).length, 2);
      await app(f, { action: 'operate', operation: { type: 'drop', shelf_id: 'shelf-app-old' } });
      await f.service.apply(plugin.id); assertRestored(f); await f.service.drop(plugin.id);
      assert.equal((await app(f, { action: 'list' })).length, 0);
    });
    await test('an old incomplete App copy receives missing original plugin attachments', async () => {
      const f = fixture('incomplete-copy');
      const id = 'shelf-imported-old';
      const pluginDir = path.join(f.globalStorage, 'shelves', crypto.createHash('sha1').update(f.root).digest('hex').slice(0, 16));
      const repoId = `git-${crypto.createHash('sha256').update(`${f.root}::Git`).digest('hex').slice(0, 16)}`;
      const appDir = path.join(f.config, 'shelves', repoId);
      for (const dir of [pluginDir, appDir]) fs.mkdirSync(dir, { recursive: true });
      const entry = { id, name: 'old imported record', date: '2026-01-01', files: [{ path: 'old.bin', status: 'untracked' }], patchFile: 'old.patch' };
      fs.writeFileSync(path.join(pluginDir, 'old.patch'), '');
      fs.writeFileSync(path.join(pluginDir, 'old.bin'), Buffer.from([0, 255, 6]));
      fs.writeFileSync(path.join(pluginDir, 'shelves.json'), JSON.stringify({ shelves: [{ ...entry, binaryFiles: [{ repoRelPath: 'old.bin', storeName: 'old.bin' }] }] }));
      fs.writeFileSync(path.join(appDir, `${id}.patch`), '');
      fs.writeFileSync(path.join(appDir, 'index.json'), JSON.stringify({ shelves: [entry] }));
      assert.equal((await app(f, { action: 'list' })).length, 1);
      assert.equal((await f.service.list()).length, 1);
      await app(f, { action: 'operate', operation: { type: 'apply', shelf_id: id } });
      assert.deepEqual(fs.readFileSync(path.join(f.root, 'old.bin')), Buffer.from([0, 255, 6]));
      await app(f, { action: 'operate', operation: { type: 'drop', shelf_id: id } });
      assert.equal((await f.service.list()).length, 0);
    });
    await test('Rust partial restore handles literal bracket names', async () => {
      const f = fixture('app-partial'); fs.writeFileSync(path.join(f.root, '[x].txt'), 'selected\n'); fs.writeFileSync(path.join(f.root, 'x.txt'), 'other\n');
      await app(f, { action: 'operate', operation: { type: 'create', name: 'partial app', paths: [] } });
      const entry = (await f.service.list())[0];
      await app(f, { action: 'operate', operation: { type: 'apply', shelf_id: entry.id, paths: ['[x].txt'] } });
      assert.equal(fs.readFileSync(path.join(f.root, '[x].txt'), 'utf8'), 'selected\n'); assert.equal(fs.existsSync(path.join(f.root, 'x.txt')), false);
    });
    await test('Rust validates attachment destinations before changing tracked files', async () => {
      const f = fixture('app-guard'); prepareChanges(f); const entry = await f.service.push('guard'); fs.writeFileSync(path.join(f.root, 'new.bin'), 'keep');
      const error = await app(f, { action: 'operate', operation: { type: 'apply', shelf_id: entry.id } }, true); assert.equal(error.code, 'SHELF_RESTORE_FAILED');
      assert.equal(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8'), 'original\n'); assert.equal(fs.readFileSync(path.join(f.root, 'new.bin'), 'utf8'), 'keep');
    });
    await test('concurrent TypeScript and Rust writers preserve rename and deletion', async () => {
      const f = fixture('mixed-concurrent');
      fs.writeFileSync(path.join(f.root, 'file.txt'), 'a\n'); const a = await f.service.push('a');
      fs.writeFileSync(path.join(f.root, 'file.txt'), 'b\n'); const b = await f.service.push('b');
      await Promise.all([app(f, { action: 'operate', operation: { type: 'drop', shelf_id: a.id } }), f.second.rename(b.id, 'retained')]);
      const entries = await f.service.list(); assert.equal(entries.length, 1); assert.equal(entries[0].name, 'retained');
    });
    await test('Rust honors the same cross-process lock without changing metadata', async () => {
      const f = fixture('app-lock'); fs.writeFileSync(path.join(f.root, 'file.txt'), 'saved\n'); const entry = await f.service.push('before');
      const before = fs.readFileSync(path.join(f.shared, 'shelves.json')); fs.mkdirSync(path.join(f.shared, '.lock'));
      const error = await app(f, { action: 'operate', operation: { type: 'drop', shelf_id: entry.id } }, true); assert.equal(error.code, 'SHELF_STORAGE_BUSY');
      assert.deepEqual(fs.readFileSync(path.join(f.shared, 'shelves.json')), before); fs.rmdirSync(path.join(f.shared, '.lock'));
    });
  }
  console.log(`${passed} shelf integration tests passed${desktop ? ' with real Rust counterpart' : '; pass --desktop PATH to verify both clients'}`);
} finally { fs.rmSync(base, { recursive: true, force: true }); }
