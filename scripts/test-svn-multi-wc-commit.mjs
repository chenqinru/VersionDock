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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'versiondock-svn-commit-test-'));
const format = (message, ...args) => String(message).replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ''));
const vscode = {
  l10n: { t: format },
  Disposable: class { constructor(fn) { this.dispose = fn; } },
  ProgressLocation: { Notification: 15 },
  QuickPickItemKind: { Separator: -1 },
  extensions: { getExtension: () => undefined },
  workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback, inspect: () => undefined, update: async () => undefined }) },
  commands: { executeCommand: async () => undefined },
  Uri: { file: fsPath => ({ fsPath }) },
  env: { appName: 'Visual Studio Code', language: 'en' },
  window: {
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    withProgress: async (_, fn) => fn({ report() {} }),
  },
};

const hasSvn = (() => {
  try { execFileSync('svn', ['--version', '--quiet'], { stdio: 'ignore' }); execFileSync('svnadmin', ['--version', '--quiet'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
if (!hasSvn) {
  console.log('SKIPPED SVN multi working copy commit scenarios: svn/svnadmin are not installed.');
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

const bundle = await build({
  stdin: {
    contents: "export {SvnService} from './src/host/svn/SvnService'; export {groupSvnWorkingCopiesByUuid} from './src/host/vcs/svnCommitGrouping';",
    resolveDir: root,
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['vscode', 'simple-git'],
});
const module = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: id => id === 'vscode' ? vscode : require(id),
  process, Buffer, console, setTimeout, clearTimeout, URL, TextDecoder, TextEncoder,
});
const { SvnService, groupSvnWorkingCopiesByUuid } = module.exports;

const svn = (cwd, ...args) => execFileSync('svn', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const repositoryUrl = repoPath => `file://${repoPath}`;
const headRevision = url => Number(svn(dir, 'info', '--show-item', 'revision', url));
const changedPathsOfHead = url => Array.from(
  svn(dir, 'log', '-v', '--xml', '-l', '1', url).matchAll(/<path[^>]*>([^<]+)<\/path>/g),
  match => match[1],
);

function seedRepository(name) {
  const repoPath = path.join(dir, name);
  execFileSync('svnadmin', ['create', repoPath], { stdio: 'ignore' });
  const url = repositoryUrl(repoPath);
  svn(dir, 'mkdir', `${url}/formal`, `${url}/test`, '-m', 'init');
  svn(dir, 'mkdir', `${url}/formal/trunk`, `${url}/test/trunk`, '-m', 'trunks');
  const formal = path.join(dir, `${name}-formal`);
  const test = path.join(dir, `${name}-test`);
  svn(dir, 'checkout', `${url}/formal/trunk`, formal);
  svn(dir, 'checkout', `${url}/test/trunk`, test);
  fs.writeFileSync(path.join(formal, 'f1.txt'), 'formal seed\n');
  fs.writeFileSync(path.join(test, 'f2.txt'), 'test seed\n');
  svn(formal, 'add', 'f1.txt');
  svn(test, 'add', 'f2.txt');
  svn(formal, 'commit', '-m', 'seed formal');
  svn(test, 'commit', '-m', 'seed test');
  return { url, formal, test };
}

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
try {
  const repo = seedRepository('repo');
  const formalService = new SvnService('formal', repo.formal);
  const testService = new SvnService('test', repo.test);
  let other;
  let otherService;

  await test('working copies of one repository expose the same repository UUID', async () => {
    const formalUuid = await formalService.getRepositoryUuid();
    const testUuid = await testService.getRepositoryUuid();
    assert.ok(formalUuid);
    assert.equal(formalUuid, testUuid);
  });

  await test('grouping merges only working copies that share a repository UUID', () => {
    const groups = groupSvnWorkingCopiesByUuid([
      { repoId: 'formal', repositoryUuid: 'uuid-1' },
      { repoId: 'test', repositoryUuid: 'uuid-1' },
      { repoId: 'other', repositoryUuid: 'uuid-2' },
      { repoId: 'unknown' },
    ]);
    assert.deepEqual(Array.from(groups.get('formal')), ['formal', 'test']);
    assert.deepEqual(Array.from(groups.get('test')), ['formal', 'test']);
    assert.equal(groups.get('other'), undefined);
    assert.equal(groups.get('unknown'), undefined);
    assert.deepEqual(groupSvnWorkingCopiesByUuid([{ repoId: 'single', repositoryUuid: 'uuid-1' }]).size, 0);
  });

  await test('selected files from two working copies land in a single revision', async () => {
    const before = headRevision(repo.url);
    fs.writeFileSync(path.join(repo.formal, 'f1.txt'), 'formal edited\n');
    fs.writeFileSync(path.join(repo.test, 'f2.txt'), 'test edited\n');
    fs.writeFileSync(path.join(repo.test, 'f3-new.txt'), 'test added\n');

    const formalTargets = await formalService.prepareCommitTargets(['f1.txt']);
    const testTargets = await testService.prepareCommitTargets(['f2.txt', 'f3-new.txt']);
    assert.equal(formalTargets.length, 1);
    assert.equal(testTargets.length, 2);
    assert.ok(formalTargets.every(target => path.isAbsolute(target)));

    await formalService.commitAbsoluteTargets('one revision for both trunks', [...formalTargets, ...testTargets]);

    assert.equal(headRevision(repo.url), before + 1);
    assert.deepEqual(changedPathsOfHead(repo.url).sort(), ['/formal/trunk/f1.txt', '/test/trunk/f2.txt', '/test/trunk/f3-new.txt']);
    assert.equal(svn(repo.formal, 'status'), '');
    assert.equal(svn(repo.test, 'status'), '');
  });

  await test('targets from an unrelated repository are rejected without a partial commit', async () => {
    other = seedRepository('other');
    const before = headRevision(repo.url);
    const otherBefore = headRevision(other.url);
    fs.writeFileSync(path.join(repo.formal, 'f1.txt'), 'formal again\n');
    fs.writeFileSync(path.join(other.formal, 'f1.txt'), 'other again\n');

    const formalTargets = await formalService.prepareCommitTargets(['f1.txt']);
    const otherServiceLocal = new SvnService('other-formal', other.formal);
    otherService = otherServiceLocal;
    const otherTargets = await otherServiceLocal.prepareCommitTargets(['f1.txt']);

    await assert.rejects(
      formalService.commitAbsoluteTargets('mixed repositories', [...formalTargets, ...otherTargets]),
    );
    assert.equal(headRevision(repo.url), before);
    assert.equal(headRevision(other.url), otherBefore);
    assert.notEqual(svn(other.formal, 'status'), '', 'unrelated repository change must stay pending');
    assert.notEqual(svn(repo.formal, 'status'), '', 'pending local change must stay pending');
  });

  await test('single working copy commitPaths still commits its own selected files', async () => {
    const before = headRevision(other.url);
    fs.writeFileSync(path.join(other.formal, 'f1.txt'), 'other single\n');
    await otherService.commitPaths('single working copy commit', ['f1.txt']);
    assert.equal(headRevision(other.url), before + 1);
    assert.equal(svn(other.formal, 'status'), '');
  });

  console.log(`${passed} real SVN multi working copy commit scenarios passed.`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
