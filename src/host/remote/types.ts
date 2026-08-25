import type * as vscode from 'vscode';

export type RemoteProviderKind = 'github' | 'gitlab';

export type RemoteVisibility = 'private' | 'public' | 'internal';

export interface RemoteNamespace {
  id: string;
  name: string;
  fullPath: string;
  kind: 'user' | 'organization' | 'group';
  host: string;
}

export interface RemoteRepository {
  id: string;
  provider: RemoteProviderKind;
  host: string;
  name: string;
  fullName: string;
  cloneUrl: string;
  webUrl?: string;
  defaultBranch?: string;
  namespace?: RemoteNamespace;
  private: boolean;
}

export interface CreateRepositoryInput {
  name: string;
  visibility: RemoteVisibility;
  namespace?: RemoteNamespace;
}

export interface GitCredentials {
  username: string;
  password: string;
}

export interface RemoteRepositoryProvider {
  readonly kind: RemoteProviderKind;
  readonly name: string;
  readonly host: string;
  listRepositories(query?: string): Promise<RemoteRepository[]>;
  listNamespaces(): Promise<RemoteNamespace[]>;
  getBranches(url: string): Promise<string[]>;
  createRepository(input: CreateRepositoryInput): Promise<RemoteRepository>;
  getCredentials(host: vscode.Uri): vscode.ProviderResult<GitCredentials | undefined>;
}

export type PublishMissingRemote = (repoId: string, rootPath: string) => Promise<void>;

export class RemoteRepositoryCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteRepositoryCancelledError';
  }
}

export function isRemoteRepositoryCancelled(error: unknown): boolean {
  if (error instanceof RemoteRepositoryCancelledError) return true;
  if (!(error instanceof Error)) return false;
  return /remote repository creation cancelled|gitlab account selection cancelled/i.test(error.message);
}
