import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { API, GitExtension, Repository } from './git.d';

let _api: API | undefined;

function getApi(): API | undefined {
  if (_api) return _api;
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) return undefined;
  const gitExt = ext.isActive ? ext.exports : undefined;
  if (!gitExt) return undefined;
  _api = gitExt.getAPI(1);
  return _api;
}

export function getVscodeGitApi(): API | undefined {
  return getApi();
}

export function getVscodeRepository(rootPath: string): Repository | undefined {
  const api = getApi();
  if (!api) return undefined;
  const repo = api.getRepository(vscode.Uri.file(rootPath));
  if (!repo) return undefined;
  // Only use this repository if its root exactly matches the requested path.
  // api.getRepository() returns the nearest ancestor repo, which may be the
  // parent repo when querying a submodule path — causing operations to run
  // against the wrong repository.
  const canonicalize = (value: string): string => {
    let resolved = path.resolve(value);
    try { resolved = fs.realpathSync.native(resolved); } catch { /* best-effort for transient paths */ }
    resolved = resolved.replace(/[/\\]+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const repoRoot = canonicalize(repo.rootUri.fsPath);
  const requested = canonicalize(rootPath);
  return repoRoot === requested ? repo : undefined;
}
