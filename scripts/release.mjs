import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function packageVersion(root) {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
  if (!stableVersion.test(pkg.version)) throw new Error('Release version must be a stable X.Y.Z version.');
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
    throw new Error('package.json and both root package-lock.json versions must match.');
  }
  return pkg.version;
}

export function resolveRelease(root, { event, inputTag = '', refName = '' }) {
  if (!['push', 'workflow_dispatch'].includes(event)) throw new Error(`Unsupported release event: ${event}`);
  const version = packageVersion(root);
  const tag = event === 'push' ? refName : inputTag || `v${version}`;
  if (!stableTag.test(tag) || tag !== `v${version}`) {
    throw new Error(`Release tag must match package.json: expected v${version}, received ${tag}.`);
  }
  let commit;
  try {
    commit = git(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  if (commit && commit !== git(root, ['rev-parse', 'HEAD'])) {
    throw new Error(`Tag ${tag} belongs to another commit. Select that tag as the workflow ref; existing tags are never moved.`);
  }
  if (event === 'push' && !commit) throw new Error(`Pushed release tag is missing: ${tag}`);
  return { version, tag, tagExists: Boolean(commit) };
}

export function releaseNotes(root, tag, repositoryUrl) {
  if (!stableTag.test(tag)) throw new Error('Invalid release tag.');
  // Find the nearest release in this commit's ancestry, excluding the current
  // tag. A globally highest version can point to a later or unrelated branch.
  const candidates = git(root, ['for-each-ref', '--format=%(refname:strip=2)', 'refs/tags'])
    .split('\n').filter(value => stableTag.test(value) && value !== tag);
  let previous;
  if (candidates.length) {
    try {
      previous = git(root, ['describe', '--tags', '--abbrev=0', ...candidates.map(value => `--match=${value}`), 'HEAD']);
    } catch (error) {
      if (error.status !== 128) throw error;
    }
  }
  const range = previous ? `${previous}..HEAD` : 'HEAD';
  const commits = git(root, ['log', range, '--no-merges', '--format=%s']).split('\n')
    .filter(value => value && !/^chore(?:\([^)]*\))?!?:\s*(?:bump version|更新版本号)/i.test(value));
  const groups = new Map([
    ['feat', ['Features', []]], ['fix', ['Bug Fixes', []]], ['perf', ['Performance', []]],
    ['refactor', ['Refactoring', []]], ['docs', ['Documentation', []]], ['test', ['Tests', []]],
    ['style', ['Style', []]], ['ci', ['CI', []]], ['build', ['Build', []]],
    ['chore', ['Chores', []]], ['other', ['Other', []]],
  ]);
  for (const subject of commits) {
    const match = subject.match(/^([a-z]+)(?:\([^)]*\))?(!)?:\s*(.+)$/);
    if (match && groups.has(match[1])) groups.get(match[1])[1].push(`${match[2] ? '**Breaking:** ' : ''}${match[3]}`);
    else groups.get('other')[1].push(subject);
  }
  let notes = [...groups.values()].filter(([, entries]) => entries.length)
    .map(([title, entries]) => `### ${title}\n\n${entries.map(value => `- ${value}`).join('\n')}\n`).join('\n');
  if (!notes) notes = 'No changes.\n';
  if (previous && repositoryUrl) notes += `\n**Full diff**: ${repositoryUrl}/compare/${previous}...${tag}\n`;
  return notes;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const root = process.cwd();
    if (process.argv[2] === 'prepare') {
      const release = resolveRelease(root, { event: process.env.RELEASE_EVENT, inputTag: process.env.RELEASE_INPUT_TAG, refName: process.env.RELEASE_REF_NAME });
      const outputs = `version=${release.version}\ntag=${release.tag}\ntag_exists=${release.tagExists}\n`;
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs);
      console.log(outputs.trim());
    } else if (process.argv[2] === 'notes') {
      const repositoryUrl = process.env.GITHUB_REPOSITORY ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}` : undefined;
      mkdirSync(resolve(root, 'dist'), { recursive: true });
      writeFileSync(resolve(root, 'dist/release-notes.md'), releaseNotes(root, process.env.RELEASE_TAG, repositoryUrl));
      console.log('Release notes written to dist/release-notes.md');
    } else throw new Error('Usage: node scripts/release.mjs prepare|notes');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
