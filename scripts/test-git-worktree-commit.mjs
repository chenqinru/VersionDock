// Regression tests for the combined Git worktree commit: linked worktrees of
// one repository instance commit as ONE commit on the primary member's branch,
// secondary members' branches fast-forward and their working trees sync to the
// combined commit. Mirrors the esbuild + vscode-stub pattern of test-git-tags.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = '/home/mrjohn/MyProjects/trae-cn-prj/vsplugin/VersionDock';
const req = createRequire(path.join(ROOT, 'package.json'));
const { build } = req('esbuild');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-git-wt-commit-'));
const format = (message, ...args) => String(message).replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ''));
const vscode = {
  l10n: { t: format },
  Disposable: class { constructor(fn) { this.dispose = fn; } },
  extensions: { getExtension: () => undefined },
  workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) },
  commands: { executeCommand: async () => undefined },
  Uri: { file: fsPath => ({ fsPath }) },
  window: {
    showQuickPick: async (items, options) => (options?.canPickMany ? items : items[0]),
    showInputBox: async () => undefined,
    showWarningMessage: async (...args) => args[2],
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    withProgress: async (_, fn) => fn({ report() {} }),
  },
};
const bundle = await build({
  stdin: {
    contents: [
      "export { GitService } from './src/host/git/GitService';",
      "export { groupGitWorktreesByInstance } from './src/host/vcs/gitWorktreeGrouping';",
      "export { commitWorktreeGroupAsOne } from './src/host/vcs/gitWorktreeCommit';",
    ].join('\n'),
    resolveDir: ROOT,
  },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['vscode', 'simple-git'],
});
const module_ = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, {
  module: module_, exports: module_.exports,
  require: id => (id === 'vscode' ? vscode : req(id)),
  process, Buffer, console, setTimeout, clearTimeout, URL, TextDecoder, TextEncoder,
});
const { GitService, groupGitWorktreesByInstance, commitWorktreeGroupAsOne } = module_.exports;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const dirty = cwd => git(cwd, 'status', '--porcelain');
const headId = cwd => git(cwd, 'rev-parse', 'HEAD');
const stagedPaths = cwd => git(cwd, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).sort();
const read = (cwd, rel) => fs.readFileSync(path.join(cwd, rel), 'utf8');
const write = (cwd, rel, content) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), content); };

// One repository instance: a main checkout plus a linked worktree on another branch.
const origin = path.join(dir, 'origin.git');
fs.mkdirSync(origin);
git(origin, 'init', '--bare', '-b', 'main');
const seed = path.join(dir, 'seed');
fs.mkdirSync(seed);
git(seed, 'init', '-b', 'main');
git(seed, 'config', 'user.name', 'Regression'); git(seed, 'config', 'user.email', 'regression@example.test');
for (const rel of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) write(seed, rel, `${rel[0]}-one\n`);
git(seed, 'add', '.'); git(seed, 'commit', '-m', 'initial'); git(seed, 'push', origin, 'main');

const mainWc = path.join(dir, 'wc-main');
git(dir, 'clone', origin, mainWc);
git(mainWc, 'worktree', 'add', path.join(dir, 'wc-feature'), '-b', 'feature');
const featureWc = path.join(dir, 'wc-feature');
for (const cwd of [mainWc, featureWc]) {
  git(cwd, 'config', 'user.name', 'Regression'); git(cwd, 'config', 'user.email', 'regression@example.test');
}
const svcMain = new GitService('wc-main', mainWc);
const svcFeature = new GitService('wc-feature', featureWc);

const creds = { gitName: 'Regression', gitEmail: 'regression@example.test' };
const baseId = headId(mainWc);

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
};

try {
  await test('grouping: same instance + same commit groups; clones/diverged/detached do not', () => {
    const cloneDir = path.join(dir, 'wc-clone');
    git(dir, 'clone', origin, cloneDir);
    const groups = groupGitWorktreesByInstance([
      { repoId: 'main', gitCommonDir: path.join(mainWc, '.git'), headCommitId: baseId, branchName: 'main' },
      { repoId: 'feature', gitCommonDir: path.join(mainWc, '.git'), headCommitId: baseId, branchName: 'feature' },
      { repoId: 'clone', gitCommonDir: path.join(cloneDir, '.git'), headCommitId: baseId, branchName: 'main' },
      { repoId: 'diverged', gitCommonDir: path.join(mainWc, '.git'), headCommitId: 'f'.repeat(40), branchName: 'x' },
      { repoId: 'detached', gitCommonDir: path.join(mainWc, '.git'), headCommitId: baseId },
      { repoId: 'merging', gitCommonDir: path.join(mainWc, '.git'), headCommitId: baseId, branchName: 'y', operationState: 'merge' },
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual(Array.from(groups[0].members.map(m => m.repoId)), ['main', 'feature']);
  });

  await test('plumbing: worktrees share the common dir', async () => {
    const mainCommon = await svcMain.getGitCommonDir();
    const featureCommon = await svcFeature.getGitCommonDir();
    assert.equal(mainCommon, featureCommon);
    assert.equal(await svcMain.getHeadCommitId(), baseId);
    assert.equal((await svcMain.getCurrentBranch()).name, 'main');
    assert.equal((await svcFeature.getCurrentBranch()).name, 'feature');
  });

  await test('combined commit: one commit on the primary branch, secondaries synced clean', async () => {
    write(mainWc, 'a.txt', 'a-two\n');
    write(featureWc, 'b.txt', 'b-two\n');
    write(featureWc, 'new.txt', 'brand-new\n');
    const result = await commitWorktreeGroupAsOne({
      members: [
        { repo: svcMain, filesToStage: ['a.txt'], filesToUnstage: [] },
        { repo: svcFeature, filesToStage: ['b.txt', 'new.txt'], filesToUnstage: [] },
      ],
      message: 'combined commit from two worktrees',
      amend: false,
      credentials: creds,
    });
    // One new commit, only on the primary branch.
    assert.equal(await svcMain.getHeadCommitId(), result.commitId);
    assert.notEqual(result.commitId, baseId);
    assert.equal(git(mainWc, 'rev-list', '--count', 'HEAD'), '2');
    // The secondary branch fast-forwarded to the same commit.
    assert.equal(headId(featureWc), result.commitId);
    // The combined commit holds every member's changes.
    const show = git(mainWc, 'show', '--name-status', '--format=', 'HEAD');
    assert.match(show, /^M\ta\.txt$/m);
    assert.match(show, /^M\tb\.txt$/m);
    assert.match(show, /^A\tnew\.txt$/m);
    assert.equal(read(mainWc, 'b.txt'), 'b-two\n');
    assert.equal(read(mainWc, 'new.txt'), 'brand-new\n');
    // Both worktrees end up clean.
    assert.equal(dirty(mainWc), '');
    assert.equal(dirty(featureWc), '');
  });

  await test('sync preserves local changes in secondary worktrees and reports them', async () => {
    write(mainWc, 'c.txt', 'c-two\n');
    // featureWc carries an unrelated tracked-file modification; it must survive the sync.
    write(featureWc, 'd.txt', 'local draft\n');
    const result = await commitWorktreeGroupAsOne({
      members: [
        { repo: svcMain, filesToStage: ['c.txt'], filesToUnstage: [] },
        { repo: svcFeature, filesToStage: ['b.txt'], filesToUnstage: [] },
      ],
      message: 'second combined commit',
      amend: false,
      credentials: creds,
    });
    assert.equal(await svcMain.getHeadCommitId(), result.commitId);
    assert.equal(headId(featureWc), result.commitId);
    assert.equal(git(mainWc, 'rev-list', '--count', 'HEAD'), '3');
    // d.txt keeps its local content and is reported; nothing else stays dirty.
    assert.deepEqual(Array.from(result.preservedChanges, p => ({ repoId: p.repoId, path: p.path })), [{ repoId: 'wc-feature', path: 'd.txt' }]);
    assert.equal(read(featureWc, 'd.txt'), 'local draft\n');
    assert.match(dirty(featureWc), /d\.txt/);
    assert.equal(dirty(mainWc), '');
  });

  await test('same path selected in two members aborts the whole group', async () => {
    write(mainWc, 'a.txt', 'a-three\n');
    write(featureWc, 'a.txt', 'a-conflict\n');
    await assert.rejects(
      () => commitWorktreeGroupAsOne({
        members: [
          { repo: svcMain, filesToStage: ['a.txt'], filesToUnstage: [] },
          { repo: svcFeature, filesToStage: ['a.txt'], filesToUnstage: [] },
        ],
        message: 'should not happen',
        amend: false,
        credentials: creds,
      }),
      /selected in more than one worktree/,
    );
    // The guard runs before anything is staged: no new commit, selections untouched.
    assert.equal(git(mainWc, 'rev-list', '--count', 'HEAD'), '3');
    assert.match(dirty(mainWc), /a\.txt/);
    assert.match(dirty(featureWc), /a\.txt/);
  });

  await test('apply failure leaves the primary index restored to its own selection', async () => {
    // Reset the aborted selections from the previous case.
    git(mainWc, 'checkout', '--', 'a.txt');
    git(featureWc, 'checkout', '--', 'a.txt');
    // The secondary stages a.txt but only lists e.txt, so the path-overlap guard
    // cannot see it; its patch therefore collides with the primary's staged a.txt
    // and the index application must fail.
    write(mainWc, 'a.txt', 'a-main-unique\n');
    git(mainWc, 'add', 'a.txt');
    write(featureWc, 'a.txt', 'a-feature-unique\n');
    git(featureWc, 'add', 'a.txt');
    write(featureWc, 'e.txt', 'pending\n');
    git(featureWc, 'add', 'e.txt');
    const headBefore = headId(mainWc);
    await assert.rejects(
      () => commitWorktreeGroupAsOne({
        members: [
          { repo: svcMain, filesToStage: ['a.txt'], filesToUnstage: [] },
          { repo: svcFeature, filesToStage: ['e.txt'], filesToUnstage: [] },
        ],
        message: 'must not be created',
        amend: false,
        credentials: creds,
      }),
      /a\.txt|patch|apply/i,
    );
    // No new commit; the primary index holds exactly its own selection again.
    assert.equal(headId(mainWc), headBefore);
    assert.deepEqual(stagedPaths(mainWc), ['a.txt']);
    // The secondary keeps its own staged state untouched.
    assert.deepEqual(stagedPaths(featureWc), ['a.txt', 'e.txt']);
  });

  console.log(`\n${passed}/6 git worktree combined-commit tests passed`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
