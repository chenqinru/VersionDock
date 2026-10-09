import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { packageVersion, releaseNotes, resolveRelease } from './release.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'versiondock-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Release Test'); git('config', 'user.email', 'release@example.test'); git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ version: '1.0.0', packages: { '': { version: '1.0.0' } } }));
  const commit = subject => { writeFileSync(join(root, 'change.txt'), `${subject}\n${Math.random()}`); git('add', '.'); git('commit', '-m', subject); };
  commit('feat(core): initial release');
  return { root, git, commit };
}

test('manual release resolves stable version, accepts an identical existing tag and rejects mismatches', t => {
  const { root, git } = fixture(t);
  assert.deepEqual(resolveRelease(root, { event: 'workflow_dispatch' }), { version: '1.0.0', tag: 'v1.0.0', tagExists: false });
  git('tag', '-a', 'v1.0.0', '-m', 'first');
  assert.equal(resolveRelease(root, { event: 'workflow_dispatch', inputTag: 'v1.0.0' }).tagExists, true);
  assert.equal(resolveRelease(root, { event: 'push', refName: 'v1.0.0' }).tagExists, true);
  for (const inputTag of ['v1.0.1', 'v1.0.0-beta.1', 'v01.0.0', 'v1.0.0\nwrong-output=true', '$(touch injected)', '../escape']) {
    assert.throws(() => resolveRelease(root, { event: 'workflow_dispatch', inputTag }), /Release tag must match/);
  }
});

test('an existing tag pointing at older source is never silently moved or rebuilt from newer code', t => {
  const { root, git, commit } = fixture(t);
  git('tag', 'v1.0.0'); commit('fix(core): later work without version bump');
  assert.throws(() => resolveRelease(root, { event: 'workflow_dispatch' }), /another commit/);
});

test('pushed tags must exist, and package and lockfile root versions must agree', t => {
  const { root } = fixture(t);
  assert.throws(() => resolveRelease(root, { event: 'push', refName: 'v1.0.0' }), /tag is missing/);
  for (const lock of [{ version: '0.9.0', packages: { '': { version: '1.0.0' } } }, { version: '1.0.0', packages: { '': { version: '0.9.0' } } }]) {
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock));
    assert.throws(() => packageVersion(root), /versions must match/);
  }
});

test('first release always has a notes file, including test, style, CI, build and unconventional commits', t => {
  const { root, commit } = fixture(t);
  for (const subject of ['test(release): validate releases', 'style(ui): align buttons', 'ci: fix workflow', 'build: pin tools', 'custom release change']) commit(subject);
  const notes = releaseNotes(root, 'v1.0.0', 'https://example.test/project');
  for (const title of ['Features', 'Tests', 'Style', 'CI', 'Build', 'Other']) assert.ok(notes.includes(`### ${title}`), notes);
  assert.ok(!notes.includes('Full diff'));
});

test('release notes use a reachable prior tag and ignore a higher tag on another branch', t => {
  const { root, git, commit } = fixture(t);
  git('tag', 'v0.8.0'); commit('fix(api): reachable change'); git('tag', '-a', 'v0.9.0', '-m', 'previous');
  git('checkout', '-b', 'other'); commit('feat: unrelated future release'); git('tag', 'v9.0.0'); git('checkout', 'main');
  commit('feat(core)!: actual release change');
  const notes = releaseNotes(root, 'v1.0.0', 'https://example.test/project');
  assert.match(notes, /\*\*Breaking:\*\* actual release change/);
  assert.match(notes, /compare\/v0\.9\.0\.\.\.v1\.0\.0/);
  assert.ok(!notes.includes('unrelated future release')); assert.ok(!notes.includes('reachable change'));
});

test('release notes with no changes still contain a nonempty message', t => {
  const { root, git } = fixture(t); git('tag', 'v0.9.0');
  assert.match(releaseNotes(root, 'v1.0.0'), /^No changes\.\n$/);
});

test('release CLI generates notes without any tags and rejects unsafe tags before writing action outputs', t => {
  const { root } = fixture(t);
  const script = new URL('./release.mjs', import.meta.url);
  execFileSync(process.execPath, [script.pathname, 'notes'], { cwd: root, env: { ...process.env, RELEASE_TAG: 'v1.0.0' }, stdio: 'pipe' });
  assert.match(readFileSync(join(root, 'dist/release-notes.md'), 'utf8'), /initial release/);
  const output = join(root, 'outputs.txt'); writeFileSync(output, 'existing=true\n');
  assert.throws(() => execFileSync(process.execPath, [script.pathname, 'prepare'], { cwd: root, env: { ...process.env, RELEASE_EVENT: 'workflow_dispatch', RELEASE_INPUT_TAG: 'v1.0.0\ninvalid=true', GITHUB_OUTPUT: output }, stdio: 'pipe' }));
  assert.equal(readFileSync(output, 'utf8'), 'existing=true\n');
});


test('version changes synchronize both README badges and preserve dependency versions', t => {
  const { root } = fixture(t);
  const scripts = join(root, 'scripts'); mkdirSync(scripts);
  writeFileSync(join(scripts, 'bump-version.mjs'), readFileSync(new URL('./bump-version.mjs', import.meta.url)));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ version: '1.0.0', packages: { '': { version: '1.0.0' }, 'node_modules/fixture': { version: '1.0.0' } } }));
  for (const name of ['README.md', 'README_zh.md']) {
    writeFileSync(join(root, name), '<img src="https://img.shields.io/badge/version-1.0.0-blue">\nversiondock-1.0.0.vsix\n');
  }
  for (const version of ['1.0.1', '2.0.0-beta.1']) {
    execFileSync(process.execPath, [join(scripts, 'bump-version.mjs'), version], { cwd: root, stdio: 'pipe' });
    assert.equal(JSON.parse(readFileSync(join(root, 'package.json'))).version, version);
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json')));
    assert.equal(lock.version, version); assert.equal(lock.packages[''].version, version);
    assert.equal(lock.packages['node_modules/fixture'].version, '1.0.0');
    for (const name of ['README.md', 'README_zh.md']) {
      const text = readFileSync(join(root, name), 'utf8');
      assert.ok(text.includes(`badge/version-${version.replace(/-/g, '--')}-blue`), text);
      assert.ok(text.includes(`versiondock-${version}.vsix`), text);
    }
  }
});
