import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'versiondock-tag-test-'));
const ui = { pick: undefined, input: undefined, warning: undefined, messages: [] };
const format = (message, ...args) => String(message).replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ''));
const vscode = {
  l10n: { t: format },
  Disposable: class { constructor(fn) { this.dispose = fn; } },
  ProgressLocation: { Notification: 15 },
  QuickPickItemKind: { Separator: -1 },
  extensions: { getExtension: () => undefined },
  workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) },
  commands: { executeCommand: async () => undefined },
  Uri: { file: fsPath => ({ fsPath }) },
  window: {
    showQuickPick: async (items, options) => ui.pick ? ui.pick(items, options) : options?.canPickMany ? items : items[0],
    showInputBox: async options => ui.input ? ui.input(options) : undefined,
    showWarningMessage: async (...args) => { ui.messages.push(args); return ui.warning ? ui.warning(...args) : args[2]; },
    showInformationMessage: async (...args) => { ui.messages.push(args); return undefined; },
    showErrorMessage: async (...args) => { ui.messages.push(args); return undefined; },
    withProgress: async (_, fn) => fn({ report() {} }),
  },
};
const bundle = await build({ stdin: { contents: "export {GitService} from './src/host/git/GitService'; export {GitTagWorkflow} from './src/host/tags/GitTagWorkflow'; export {BranchStatusBar} from './src/host/ui/BranchStatusBar'; export {GitLogPanelProvider} from './src/host/panels/GitLogPanelProvider';", resolveDir: root }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vscode', 'simple-git'] });
const module = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: id => id === 'vscode' ? vscode : require(id), process, Buffer, console, setTimeout, clearTimeout, URL, TextDecoder, TextEncoder });
const { GitService, GitTagWorkflow, BranchStatusBar, GitLogPanelProvider } = module.exports;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hasTag = (cwd, name) => { try { git(cwd, 'show-ref', '--verify', `refs/tags/${name}`); return true; } catch { return false; } };
const services = new Map();
function repository(name) {
  const cwd = path.join(dir, name); fs.mkdirSync(cwd); git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Tag Test'); git(cwd, 'config', 'user.email', 'tag-test@example.test');
  git(cwd, 'config', 'tag.gpgSign', 'false');
  fs.writeFileSync(path.join(cwd, 'file.txt'), 'one\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'initial');
  const remote = path.join(dir, `${name}.git`); fs.mkdirSync(remote); git(remote, 'init', '--bare'); git(cwd, 'remote', 'add', 'origin', remote);
  const service = new GitService(name, cwd);
  services.set(name, service);
  return { cwd, remote, service };
}
const manager = { getRepoMetas: () => [...services.values()].map(repo => ({ id: repo.repoId, name: repo.repoId, rootPath: repo.rootPath, kind: repo.kind, color: '#888' })), getRepo: id => services.get(id), getRepoMeta: id => manager.getRepoMetas().find(meta => meta.id === id), notifyBranchesChanged() {} };
const workflow = new GitTagWorkflow(manager);
const a = repository('a'), b = repository('b');
let passed = 0;
const test = async (name, fn) => { ui.pick = ui.input = ui.warning = undefined; await fn(); passed++; console.log(`PASS ${name}`); };
try {
  await test('lightweight and annotated tags use validated commit identities', async () => {
    await a.service.createTag('v1', 'HEAD'); await a.service.createTag('release', 'HEAD', '发布说明 中文');
    const tags = await a.service.getTags();
    assert.equal(tags.find(tag => tag.name === 'v1').tagType, 'lightweight');
    assert.equal(tags.find(tag => tag.name === 'release').tagType, 'annotated');
    assert.equal(git(a.cwd, 'cat-file', '-t', 'release'), 'tag');
    assert.match(git(a.cwd, 'cat-file', '-p', 'release'), /发布说明 中文/);
    await assert.rejects(a.service.createTag('bad name', 'HEAD'));
    await assert.rejects(a.service.createTag('v1', 'HEAD'));
    await assert.rejects(a.service.createTag('invalid-ref', '-HEAD'));
  });
  await test('creation message produces an annotated tag and preserves it when follow-up is dismissed', async () => {
    ui.pick = () => { throw new Error('Tag type must be inferred from the message'); };
    ui.input = options => options.title === 'Tag description' ? 'Release notes' : 'created-in-flow';
    assert.equal((await workflow.run({ action: 'create', repoId: 'a', hash: 'HEAD' })).outcome, 'success');
    assert.equal(git(a.cwd, 'cat-file', '-t', 'created-in-flow'), 'tag');
    assert.equal(hasTag(a.remote, 'created-in-flow'), false);
  });
  await test('creation refreshes affected refs once and cancellation does not refresh refs', async () => {
    const previousNotify = manager.notifyBranchesChanged;
    let notifications = 0;
    const events = [];
    manager.notifyBranchesChanged = () => { notifications++; };
    const subscription = workflow.onChange((busy, repoIds) => events.push({ busy, repoIds: Array.from(repoIds) }));
    try {
      ui.input = options => options.title === 'Tag description' ? '' : 'refresh-once';
      assert.equal((await workflow.run({ action: 'create', repoId: 'a', hash: 'HEAD' })).outcome, 'success');
      assert.equal(notifications, 1);
      assert.deepEqual(events, [{ busy: true, repoIds: [] }, { busy: false, repoIds: ['a'] }]);
      assert.equal(hasTag(a.cwd, 'refresh-once'), true);
      assert.equal(hasTag(a.remote, 'refresh-once'), false);
      notifications = 0;
      events.length = 0;
      ui.input = () => undefined;
      assert.equal((await workflow.run({ action: 'create', repoId: 'a', hash: 'HEAD' })).outcome, 'cancelled');
      assert.equal(notifications, 0);
      assert.deepEqual(events, [{ busy: true, repoIds: [] }, { busy: false, repoIds: [] }]);
    } finally {
      subscription.dispose();
      manager.notifyBranchesChanged = previousNotify;
    }
  });
  await test('empty and whitespace messages create lightweight tags', async () => {
    for (const [name, description] of [['advanced-empty', ''], ['advanced-whitespace', '   ']]) {
      ui.input = options => options.title === 'Tag description' ? description : name;
      assert.equal((await workflow.run({ action: 'create', repoId: 'a', hash: 'HEAD' })).outcome, 'success');
      assert.equal(git(a.cwd, 'cat-file', '-t', `refs/tags/${name}`), 'commit');
      assert.equal(hasTag(a.remote, name), false);
    }
  });
  await test('advanced creation selects the preferred repository and validates a commit expression', async () => {
    fs.writeFileSync(path.join(b.cwd, 'file.txt'), 'advanced\n'); git(b.cwd, 'commit', '-am', 'advanced target');
    ui.pick = items => { assert.equal(items[0].meta.id, 'b'); return items[0]; };
    ui.input = async options => {
      if (options.title === 'Commit for tag in b') {
        assert.equal(options.value, 'HEAD');
        assert.equal(await options.validateInput('main~1'), undefined);
        assert.equal(await options.validateInput(''), undefined);
        assert.ok(await options.validateInput('missing-commit'));
        return 'main~1';
      }
      return options.title === 'Tag description' ? 'Release on an older commit' : 'advanced-ref';
    };
    assert.equal((await workflow.run({ action: 'create', repoIds: ['a', 'b'], preferredRepoId: 'b' })).outcome, 'success');
    assert.equal(git(b.cwd, 'rev-parse', 'refs/tags/advanced-ref^{commit}'), git(b.cwd, 'rev-parse', 'main~1'));
    assert.equal(git(b.cwd, 'cat-file', '-t', 'refs/tags/advanced-ref'), 'tag');
    assert.equal(hasTag(a.cwd, 'advanced-ref'), false);
    assert.equal(hasTag(b.remote, 'advanced-ref'), false);
  });
  await test('cancelling any advanced creation step leaves all repositories untouched', async () => {
    const before = [a, b].map(repo => git(repo.cwd, 'for-each-ref', '--format=%(refname):%(objectname)', 'refs/tags'));
    for (const stage of ['repository', 'commit', 'name', 'description']) {
      ui.pick = items => stage === 'repository' ? undefined : items[0];
      ui.input = options => {
        if (options.title === 'Commit for tag in a') return stage === 'commit' ? undefined : '';
        if (options.title === 'Tag description') return stage === 'description' ? undefined : 'Release notes';
        return stage === 'name' ? undefined : 'advanced-cancelled';
      };
      assert.equal((await workflow.run({ action: 'create', repoIds: ['a', 'b'] })).outcome, 'cancelled');
      assert.deepEqual([a, b].map(repo => git(repo.cwd, 'for-each-ref', '--format=%(refname):%(objectname)', 'refs/tags')), before);
    }
  });
  await test('single push uses tag ref even with a colliding branch name', async () => {
    git(a.cwd, 'branch', 'release');
    const result = await workflow.run({ action: 'push', repoId: 'a', tagName: 'release' });
    assert.equal(result.outcome, 'success');
    assert.equal(git(a.remote, 'rev-parse', 'refs/tags/release'), git(a.cwd, 'rev-parse', 'refs/tags/release'));
    assert.equal(git(a.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/release'), '');
  });
  await test('single-repository status menu restores Back, merge target and remote-specific push', async () => {
    const statusBar = Object.create(BranchStatusBar.prototype);
    let wentBack = false;
    Object.assign(statusBar, { manager, refresh: async () => {}, showRepoBranchMenu: async () => { wentBack = true; } });
    ui.pick = (items, options) => {
      assert.equal(options.title, 'Tag: release — a');
      assert.deepEqual(Array.from(items.filter(item => item.kind !== -1), item => item.label), [
        '$(arrow-left) Back', '$(arrow-right) Checkout', '$(git-merge) Merge "release" into "main"', '$(cloud-upload) Push to "origin"', '$(trash) Delete tag',
      ]);
      return items[0];
    };
    await statusBar.showSingleTagActionMenu('release', manager.getRepoMeta('a'), 'main');
    assert.equal(wentBack, true);
    ui.pick = items => { assert.equal(items.some(item => item.label.startsWith('$(git-merge)')), false); return undefined; };
    await statusBar.showSingleTagActionMenu('release', manager.getRepoMeta('a'), 'HEAD', true);
  });
  await test('status menu pushes only to the explicitly selected remote', async () => {
    const backup = path.join(dir, 'menu-backup.git'); fs.mkdirSync(backup); git(backup, 'init', '--bare');
    git(a.cwd, 'remote', 'add', 'backup', backup);
    await a.service.createTag('menu-push', 'HEAD');
    const statusBar = Object.create(BranchStatusBar.prototype);
    Object.assign(statusBar, { manager, refresh: async () => {} });
    ui.pick = items => items.find(item => item.label === '$(cloud-upload) Push to "backup"');
    try {
      await statusBar.showSingleTagActionMenu('menu-push', manager.getRepoMeta('a'), 'main');
      assert.equal(hasTag(backup, 'menu-push'), true); assert.equal(hasTag(a.remote, 'menu-push'), false);
    } finally { git(a.cwd, 'remote', 'remove', 'backup'); }
    const result = await workflow.run({ action: 'push', repoId: 'a', tagName: 'menu-push', remote: 'backup' });
    assert.equal(result.outcome, 'failed'); assert.equal(hasTag(a.remote, 'menu-push'), false);
  });
  await test('multi-repository status menu restores the original actions and Back navigation', async () => {
    const statusBar = Object.create(BranchStatusBar.prototype);
    let wentBack = false;
    Object.assign(statusBar, { manager, showMenu: async () => { wentBack = true; } });
    ui.pick = items => {
      assert.deepEqual(Array.from(items.filter(item => item.kind !== -1), item => item.label), [
        '$(arrow-left) Back', '$(arrow-right) Checkout', '$(git-merge) Merge "release" into "main"', '$(cloud-upload) Push to "origin"', '$(trash) Delete tag',
      ]);
      return items[0];
    };
    await statusBar.showCommonTagActionMenu('release', [manager.getRepoMeta('a'), manager.getRepoMeta('b')]);
    assert.equal(wentBack, true);
  });
  await test('commit tag management restores only Back, merge and delete', async () => {
    const provider = Object.create(GitLogPanelProvider.prototype);
    Object.assign(provider, { manager });
    let listCount = 0;
    ui.pick = (items, options) => {
      if (options.title.startsWith('Tags on commit')) {
        listCount++;
        return listCount === 1 ? items.find(item => item.tagName === 'release') : undefined;
      }
      assert.deepEqual(Array.from(items.filter(item => item.kind !== -1), item => item.label), [
        '$(arrow-left) Back', '$(git-merge) Merge "release" into "main"', '$(trash) Delete "release"',
      ]);
      return items[0];
    };
    await provider.showManageCommitTagsMenu(a.service, 'a', git(a.cwd, 'rev-parse', 'HEAD'), ['release'], 'main');
    assert.equal(listCount, 2);
  });
  await test('retained SVN checkout, merge and deletion messages use the SVN handlers', async () => {
    const id = 'svn-routing';
    const operations = [];
    const svn = {
      repoId: id, rootPath: path.join(dir, id), kind: 'svn',
      getCurrentBranch: async () => ({ name: 'trunk' }),
      getBranches: async () => [],
      checkoutTag: async name => { operations.push(['checkout', name]); },
      mergeTag: async name => { operations.push(['merge', name]); },
      deleteTag: async name => { operations.push(['delete', name]); },
    };
    services.set(id, svn);
    const replies = [];
    const provider = Object.create(GitLogPanelProvider.prototype);
    Object.assign(provider, {
      manager: { ...manager, refreshStatusNow: async () => {} },
      post: message => replies.push(message),
      refresh: () => {}, refreshTags: async () => {},
      getNonWorktreeRepos: () => manager.getRepoMetas(),
      showOperationError: error => { throw error; },
    });
    try {
      await provider.handleMessage({ type: 'LOG_CHECKOUT_TAG', requestId: 'svn-checkout', repoId: id, tagName: 'release' });
      await provider.handleMessage({ type: 'LOG_MERGE_TAG_MULTI', requestId: 'svn-merge', repoIds: [id], tagName: 'release' });
      await provider.handleMessage({ type: 'LOG_DELETE_TAG_MULTI', requestId: 'svn-delete', repoIds: [id], tagName: 'release' });
      assert.deepEqual(operations, [['checkout', 'release'], ['merge', 'release'], ['delete', 'release']]);
      for (const requestId of ['svn-checkout', 'svn-merge', 'svn-delete']) {
        assert.ok(replies.some(reply => reply.type === 'LOG_BRANCH_OP_RESULT' && reply.requestId === requestId && reply.ok));
      }
    } finally { services.delete(id); }
  });
  await test('cancelling second remote selection leaves every repository untouched', async () => {
    for (const r of [a, b]) { await r.service.createTag('cancel', 'HEAD'); await r.service.pushTag('cancel', 'origin'); git(r.cwd, 'remote', 'add', 'backup', r.remote); }
    let remotePicks = 0;
    ui.pick = (items, options) => options.canPickMany ? items : options.title?.startsWith('Select remote')
      ? (++remotePicks === 2 ? undefined : 'origin') : items.find(item => item.value === 'both') ?? items[0];
    assert.equal((await workflow.run({ action: 'delete', repoIds: ['a', 'b'], tagName: 'cancel' })).outcome, 'cancelled');
    for (const r of [a, b]) { assert.equal(hasTag(r.cwd, 'cancel'), true); assert.equal(hasTag(r.remote, 'cancel'), true); git(r.cwd, 'remote', 'remove', 'backup'); }
  });
  await test('local and remote deletion ranges preserve the opposite side', async () => {
    ui.pick = items => items.find(item => item.value === 'local') ?? items[0];
    assert.equal((await workflow.run({ action: 'delete', repoId: 'a', tagName: 'cancel' })).outcome, 'success');
    assert.equal(hasTag(a.remote, 'cancel'), true); assert.equal(hasTag(a.cwd, 'cancel'), false);
    ui.pick = items => items.find(item => item.value === 'remote') ?? items[0];
    assert.equal((await workflow.run({ action: 'delete', repoId: 'b', tagName: 'cancel' })).outcome, 'success');
    assert.equal(hasTag(b.remote, 'cancel'), false); assert.equal(hasTag(b.cwd, 'cancel'), true);
  });
  await test('remote rejection retains local tag and is reported as failure', async () => {
    await b.service.pushTag('cancel', 'origin');
    fs.writeFileSync(path.join(b.remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    ui.pick = items => items.find(item => item.value === 'both') ?? items[0];
    const result = await workflow.run({ action: 'delete', repoId: 'b', tagName: 'cancel' });
    assert.equal(result.outcome, 'failed'); assert.equal(result.targets[0].remoteResult, 'failed');
    assert.equal(hasTag(b.cwd, 'cancel'), true); assert.equal(hasTag(b.remote, 'cancel'), true);
    fs.unlinkSync(path.join(b.remote, 'hooks/pre-receive'));
  });
  await test('local lock failure after remote deletion reports partial success', async () => {
    const lock = path.join(b.cwd, '.git/refs/tags/cancel.lock'); fs.writeFileSync(lock, '');
    ui.pick = items => items.find(item => item.value === 'both') ?? items[0];
    const result = await workflow.run({ action: 'delete', repoId: 'b', tagName: 'cancel' });
    assert.equal(result.outcome, 'partial'); assert.equal(result.targets[0].remoteResult, 'success');
    assert.equal(result.targets[0].local, 'failed'); assert.equal(hasTag(b.cwd, 'cancel'), true); assert.equal(hasTag(b.remote, 'cancel'), false);
    fs.unlinkSync(lock);
  });
  await test('same-name multi-repository push processes every selected target and reports partial failure', async () => {
    for (const r of [a, b]) await r.service.createTag('multi', 'HEAD');
    fs.writeFileSync(path.join(b.remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const result = await workflow.run({ action: 'push', repoIds: ['a', 'b'], tagName: 'multi' });
    assert.equal(result.outcome, 'partial'); assert.equal(result.targets.length, 2);
    assert.equal(hasTag(a.remote, 'multi'), true); assert.equal(hasTag(b.remote, 'multi'), false);
    fs.unlinkSync(path.join(b.remote, 'hooks/pre-receive'));
  });
  await test('annotated checkout resolves the tag instead of a colliding branch', async () => {
    git(a.cwd, 'branch', '-f', 'release', 'HEAD');
    await a.service.checkoutTag('release');
    assert.equal(git(a.cwd, 'rev-parse', 'HEAD'), git(a.cwd, 'rev-parse', 'refs/tags/release^{commit}'));
    await assert.rejects(a.service.mergeTag('v1'));
  });
  await test('currently checked-out local tag is protected while remote-only deletion remains available', async () => {
    await a.service.checkoutTag('release');
    ui.pick = items => items.find(item => item.value === 'local') ?? items[0];
    assert.equal((await workflow.run({ action: 'delete', repoId: 'a', tagName: 'release' })).outcome, 'failed');
    ui.pick = items => items.find(item => item.value === 'remote') ?? items[0];
    assert.equal((await workflow.run({ action: 'delete', repoId: 'a', tagName: 'release' })).outcome, 'success');
    assert.equal(hasTag(a.cwd, 'release'), true); assert.equal(hasTag(a.remote, 'release'), false);
  });
  await test('empty repositories and missing remotes are explicit and never counted as success', async () => {
    const empty = path.join(dir, 'empty'); fs.mkdirSync(empty); git(empty, 'init'); services.set('empty', new GitService('empty', empty));
    assert.equal((await workflow.run({ action: 'create', repoId: 'empty' })).outcome, 'failed');
    git(b.cwd, 'remote', 'remove', 'origin');
    assert.equal((await workflow.run({ action: 'push', repoId: 'b', tagName: 'cancel' })).outcome, 'failed');
  });
  await test('Git tag actions exclude SVN candidates', async () => {
    const mixedRepo = repository('mixed');
    await mixedRepo.service.createTag('mixed-tag', 'HEAD');
    services.set('svn', { repoId: 'svn', rootPath: path.join(dir, 'svn'), kind: 'svn', getTags() { throw Error('Git workflow touched SVN'); } });
    const mixed = await workflow.run({ action: 'push', repoIds: ['mixed', 'svn'], tagName: 'mixed-tag' });
    assert.equal(mixed.outcome, 'success');
    assert.equal(mixed.targets.length, 1); assert.equal(mixed.targets[0].repoId, 'mixed');
    assert.equal(hasTag(mixedRepo.remote, 'mixed-tag'), true);
  });
  await test('overlapping requests cannot execute twice or release another operation guard', async () => {
    let finishSelection;
    ui.pick = () => new Promise(resolve => { finishSelection = resolve; });
    const first = workflow.run({ action: 'push', repoIds: ['a', 'b'], tagName: 'multi' });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(workflow.busy, true);
    const second = await workflow.run({ action: 'push', repoId: 'a', tagName: 'multi' });
    assert.equal(second.outcome, 'cancelled'); assert.equal(workflow.busy, true);
    finishSelection(undefined);
    assert.equal((await first).outcome, 'cancelled'); assert.equal(workflow.busy, false);
  });
  await test('removed tag workflows reject stale requests without writes', async () => {
    const before = [a, b].map(repo => git(repo.cwd, 'for-each-ref', '--format=%(refname):%(objectname)', 'refs/tags'));
    for (const action of ['branch', 'fetch', 'pushAll', 'refresh']) {
      assert.equal((await workflow.run({ action, repoId: 'a', tagName: 'v1' })).outcome, 'failed');
    }
    assert.deepEqual([a, b].map(repo => git(repo.cwd, 'for-each-ref', '--format=%(refname):%(objectname)', 'refs/tags')), before);
  });
  console.log(`${passed} real Git tag workflow scenarios passed.`);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
