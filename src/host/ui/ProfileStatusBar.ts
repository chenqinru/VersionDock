import * as path from 'path';
import * as vscode from 'vscode';
import type { GitProfile } from '../git/GitProfileService';
import { GitProfileService, LOCAL_PROFILE_ID, GLOBAL_PROFILE_ID } from '../git/GitProfileService';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { GitService } from '../git/GitService';
import { SvnService, type SvnAuthenticationStatus } from '../svn/SvnService';
import type { RepoMeta } from '../types/git';
import type { RemoteRepositoryService } from '../remote/RemoteRepositoryService';
import type { RemoteAccountInfo } from '../types/messages';
import { t } from '../utils/l10n';
import { formatRepoLabel } from '../utils/repoLabels';
import type { VersionDockLogger } from '../utils/Logger';

interface RemotePlatformMatch {
  platform: 'github' | 'gitlab' | 'gitee' | 'generic';
  platformLabel?: string;
  remoteName: string;
  url: string;
}

interface RepoPlatformInfo {
  platform: 'github' | 'gitlab' | 'gitee' | 'generic';
  platformLabel?: string;
  primaryRemoteName?: string;
  primaryRemoteUrl?: string;
  secondaryPlatforms: RemotePlatformMatch[];
  remoteUrls: string[];
}

function extractHostname(urlOrHost: string): string | undefined {
  if (!urlOrHost) return undefined;
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(urlOrHost)) {
      return new URL(urlOrHost).hostname.toLowerCase();
    }
    const sshMatch = /^(?:[\w.-]+@)?([\w.-]+)(?::\d+)?(?::|\/)/.exec(urlOrHost);
    if (sshMatch && sshMatch[1]) {
      return sshMatch[1].toLowerCase();
    }
    return new URL(`http://${urlOrHost}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~$]/g, '\\$&');
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function resolveRemotePlatform(
  remote: { name: string; fetchUrl?: string; pushUrl?: string },
  connectedAccounts: RemoteAccountInfo[],
  customGitlabHosts: string[],
): RemotePlatformMatch {
  const url = remote.fetchUrl || remote.pushUrl || '';
  const hostname = extractHostname(url);
  if (!hostname) {
    return { platform: 'generic', remoteName: remote.name, url };
  }

  // 1. 优先精准匹配已连接托管账号的主机域名（精准识别自建私有 GitLab / 企业版 Gitee 等）
  for (const acc of connectedAccounts) {
    if (acc.host) {
      const accHost = extractHostname(acc.host);
      if (accHost && (hostname === accHost || hostname.endsWith(`.${accHost}`))) {
        const label = acc.provider === 'gitee' ? 'Gitee' : acc.provider === 'github' ? 'GitHub' : 'GitLab';
        return { platform: acc.provider, platformLabel: label, remoteName: remote.name, url };
      }
    }
  }

  // 2. 匹配 VS Code 设置中配置的自定义 GitLab hosts
  for (const host of customGitlabHosts) {
    const customHost = extractHostname(host);
    if (customHost && (hostname === customHost || hostname.endsWith(`.${customHost}`))) {
      return { platform: 'gitlab', platformLabel: 'GitLab', remoteName: remote.name, url };
    }
  }

  // 3. 公有云平台标准域名规则
  if (hostname === 'github.com' || hostname.endsWith('.github.com')) {
    return { platform: 'github', platformLabel: 'GitHub', remoteName: remote.name, url };
  }
  if (hostname === 'gitee.com' || hostname.endsWith('.gitee.com')) {
    return { platform: 'gitee', platformLabel: 'Gitee', remoteName: remote.name, url };
  }
  if (hostname === 'gitlab.com' || hostname.endsWith('.gitlab.com')) {
    return { platform: 'gitlab', platformLabel: 'GitLab', remoteName: remote.name, url };
  }

  return { platform: 'generic', remoteName: remote.name, url };
}

export class ProfileStatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private refreshVersion = 0;
  private lastSelectedRepoId?: string;

  constructor(
    private readonly profileService: GitProfileService,
    private readonly manager?: WorkspaceGitManager,
    private readonly logger?: VersionDockLogger,
    private readonly remoteService?: RemoteRepositoryService,
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.statusBarItem.command = 'versiondock.manageProfiles';
    this.updateVisibility();

    this.disposables.push(
      this.profileService.onProfileChange(() => this.refresh()),
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('versiondock.showProfileStatusBar')) {
          this.updateVisibility();
        }
      }),
      this.remoteService?.onDidChangeAccounts(() => this.refresh()) ?? { dispose: () => undefined },
      this.manager?.onReposChange(() => this.refresh()) ?? { dispose: () => undefined },
      this.manager?.onStatusChange(() => this.refresh()) ?? { dispose: () => undefined },
    );

    this.refresh();
  }

  updateVisibility(): void {
    const enabled = vscode.workspace.getConfiguration('versiondock').get<boolean>('showProfileStatusBar', true);
    if (enabled) {
      this.statusBarItem.show();
    } else {
      this.statusBarItem.hide();
    }
  }

  private getAllServices(): GitService[] {
    if (!this.manager) return [];
    return this.manager.getRepoMetas()
      .filter(meta => !meta.isWorktree)
      .map(meta => this.manager?.getRepo(meta.id))
      .filter((repo): repo is GitService => !!repo);
  }

  private getActiveService(allServices = this.getAllServices()): GitService | undefined {
    if (allServices.length === 0) return undefined;
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme === 'file') {
      const matches = this.manager?.getServicesForFile(editor.document.uri.fsPath);
      if (matches && matches.length > 0) {
        const matched = allServices.find(s => s.repoId === matches[0].repoId);
        if (matched) return matched;
      }
    }
    if (this.lastSelectedRepoId) {
      const remembered = allServices.find(s => s.repoId === this.lastSelectedRepoId);
      if (remembered) return remembered;
    }
    return allServices[0];
  }

  private getContextServices(): GitService[] {
    return this.getAllServices();
  }

  refresh(): void {
    const version = ++this.refreshVersion;
    const allServices = this.getAllServices();
    if (allServices.length === 0) {
      // A workspace can be open before Git has discovered a repository, or it
      // may simply contain no repository. Resolve the effective identity
      // anyway so a configured global Git identity is not shown as missing.
      void this.refreshAsync(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, version).catch(error => {
        this.logger?.error('IdentityStatus', 'Failed to refresh Git identity status', error);
        if (version === this.refreshVersion) this.renderNoProfile(version);
      });
      return;
    }

    const activeService = this.getActiveService(allServices) || allServices[0];
    if (activeService.kind === 'svn') {
      void this.refreshSvnAsync(activeService as SvnService, version, allServices);
      return;
    }

    void this.refreshAsync(activeService.rootPath, version, activeService, allServices).catch(error => {
      this.logger?.error('IdentityStatus', 'Failed to refresh Git identity status', error);
      if (version === this.refreshVersion) this.renderNoProfile(version, activeService, allServices);
    });
  }

  private async refreshAsync(
    repoPath: string | undefined,
    version = this.refreshVersion,
    activeService?: GitService,
    allServices?: GitService[],
  ): Promise<void> {
    const result = await this.profileService.getEffectiveProfile(repoPath);
    if (version !== this.refreshVersion) return;
    if (result) {
      this.renderStatusBar(result.profile, result.source, version, activeService, allServices);
    } else {
      this.renderNoProfile(version, activeService, allServices);
    }
  }

  private async refreshSvnAsync(service: SvnService, version: number, allServices?: GitService[]): Promise<void> {
    const status = await service.getAuthenticationStatus().catch(() => undefined);
    if (version !== this.refreshVersion) return;
    const account = status?.username ?? (status?.hasCachedCredentials ? t('Authenticated') : t('No account detected'));
    this.statusBarItem.text = `$(account) SVN: ${account}`;
    this.statusBarItem.tooltip = status?.authKey
      ? `${t('SVN account')}: ${account}\n${t('Authentication realm')}: ${status.realm ?? status.authKey}\n${t('Click to manage accounts and identities')}`
      : `${t('SVN account')}: ${account}\n${t('Click to manage accounts and identities')}`;

    void this.buildProfileTooltip({ svnStatus: status, activeService: service, allServices }).then(tooltip => {
      if (version === this.refreshVersion) {
        this.statusBarItem.tooltip = tooltip;
      }
    }).catch(() => {});
  }

  private async detectRepositoryPlatform(
    service?: GitService,
    preloadedAccounts?: RemoteAccountInfo[],
  ): Promise<RepoPlatformInfo> {
    if (!service || service.kind !== 'git') {
      return { platform: 'generic', secondaryPlatforms: [], remoteUrls: [] };
    }

    try {
      const remotes = await service.getRemotesWithUrls().catch(() => []);
      const remoteUrls = remotes.flatMap(r => [r.fetchUrl, r.pushUrl].filter(Boolean));
      if (remotes.length === 0) {
        return { platform: 'generic', secondaryPlatforms: [], remoteUrls: [] };
      }

      const accounts = preloadedAccounts ?? (this.remoteService ? await this.remoteService.getConnectedAccounts().catch(() => []) : []);
      const customGitlabHosts = vscode.workspace.getConfiguration('versiondock').get<string[]>('remote.gitlab.hosts', []);

      // 主远程决策（Primary Remote）：
      // 1. 优先取当前分支追踪的 upstream remote
      // 2. 其次取名为 'origin' 的 remote（Git 标准默认约定）
      // 3. 回退为第一个 remote
      let primaryRemote: { name: string; fetchUrl: string; pushUrl: string } | undefined;
      const currentBranch = await service.getCurrentBranch().catch(() => undefined);
      if (currentBranch?.upstream) {
        const upstreamRemoteName = currentBranch.upstream.split('/')[0];
        primaryRemote = remotes.find(r => r.name === upstreamRemoteName);
      }
      if (!primaryRemote) {
        primaryRemote = remotes.find(r => r.name.toLowerCase() === 'origin');
      }
      if (!primaryRemote) {
        primaryRemote = remotes[0];
      }

      const primaryMatch = resolveRemotePlatform(primaryRemote, accounts, customGitlabHosts);

      // 解析其他次要/关联远程（Secondary Remotes）
      const secondaryPlatforms: RemotePlatformMatch[] = [];
      for (const remote of remotes) {
        if (remote === primaryRemote || remote.name === primaryRemote.name) continue;
        const match = resolveRemotePlatform(remote, accounts, customGitlabHosts);
        if (match.platform !== 'generic') {
          secondaryPlatforms.push(match);
        }
      }

      return {
        platform: primaryMatch.platform,
        platformLabel: primaryMatch.platformLabel,
        primaryRemoteName: primaryRemote.name,
        primaryRemoteUrl: primaryRemote.fetchUrl || primaryRemote.pushUrl,
        secondaryPlatforms,
        remoteUrls,
      };
    } catch {
      return { platform: 'generic', secondaryPlatforms: [], remoteUrls: [] };
    }
  }

  private async buildProfileTooltip(options: {
    profile?: GitProfile;
    source?: 'active' | 'local' | 'global';
    svnStatus?: SvnAuthenticationStatus;
    activeService?: GitService;
    allServices?: GitService[];
  }): Promise<vscode.MarkdownString> {
    const md = new vscode.MarkdownString(undefined, true);
    md.supportHtml = true;
    md.isTrusted = { enabledCommands: ['versiondock.manageProfiles'] };

    const { profile, source, svnStatus, activeService, allServices } = options;

    let connected: RemoteAccountInfo[] = [];
    let githubSession: vscode.AuthenticationSession | undefined;
    if (this.remoteService) {
      [githubSession, connected] = await Promise.all([
        this.remoteService.github.getSession({ createIfNone: false }).catch(() => undefined),
        this.remoteService.getConnectedAccounts().catch(() => [] as RemoteAccountInfo[]),
      ]);
    }

    let ghAccount = connected.find(a => a.provider === 'github');
    if (!ghAccount && githubSession?.account?.label) {
      const username = githubSession.account.label;
      ghAccount = {
        provider: 'github',
        id: githubSession.account.id || username,
        username,
        avatarUrl: `https://avatars.githubusercontent.com/${encodeURIComponent(username)}`,
        host: 'https://github.com',
      };
    }
    const glAccounts = connected.filter(a => a.provider === 'gitlab');
    const gtAccount = connected.find(a => a.provider === 'gitee');

    // 检测当前仓库所属的远程平台类型与 URLs
    const repoPlatform = await this.detectRepositoryPlatform(activeService, connected);

    // ── 智能头像解析（主远程平台优先原则） ──────────────────────────
    let avatarUrl: string | null = null;

    // 1. 若当前项目主远程匹配明确的远端平台，优先使用该已连接平台的真实头像
    if (repoPlatform.platform === 'gitee' && gtAccount?.avatarUrl) {
      avatarUrl = gtAccount.avatarUrl;
    } else if (repoPlatform.platform === 'github' && ghAccount?.avatarUrl) {
      avatarUrl = ghAccount.avatarUrl;
    } else if (repoPlatform.platform === 'gitlab' && glAccounts[0]?.avatarUrl) {
      avatarUrl = glAccounts[0].avatarUrl;
    }

    // 2. 结合当前仓库 remoteUrls，通过 AvatarService 反向解析作者邮箱头像
    if (!avatarUrl && profile?.gitEmail && this.remoteService) {
      const normalizedEmail = profile.gitEmail.trim().toLowerCase();
      try {
        const resolved = await this.remoteService.avatarService.resolveAvatars(
          [profile.gitEmail],
          repoPlatform.remoteUrls,
          [{ name: profile.gitName, email: profile.gitEmail }],
        );
        avatarUrl = resolved[normalizedEmail] ?? null;
      } catch {
        // ignore
      }
    }

    // 3. 根据提交邮箱反推已绑定的账号平台
    if (!avatarUrl && profile?.gitEmail) {
      const normalizedEmail = profile.gitEmail.trim().toLowerCase();
      const matchedRemote = connected.find(acc =>
        acc.emails?.some(e => e.toLowerCase() === normalizedEmail)
      );
      if (matchedRemote?.avatarUrl) {
        avatarUrl = matchedRemote.avatarUrl;
      }
    }

    // 4. 若主远程未解析到头像，但存在关联的次要远程平台，尝试使用关联平台的头像
    if (!avatarUrl) {
      for (const sec of repoPlatform.secondaryPlatforms) {
        if (sec.platform === 'gitee' && gtAccount?.avatarUrl) {
          avatarUrl = gtAccount.avatarUrl;
          break;
        } else if (sec.platform === 'github' && ghAccount?.avatarUrl) {
          avatarUrl = ghAccount.avatarUrl;
          break;
        } else if (sec.platform === 'gitlab' && glAccounts[0]?.avatarUrl) {
          avatarUrl = glAccounts[0].avatarUrl;
          break;
        }
      }
    }

    // 5. 保底回退：若未识别特定平台，回退到已连接的账号头像
    if (!avatarUrl) {
      avatarUrl = glAccounts[0]?.avatarUrl ?? ghAccount?.avatarUrl ?? gtAccount?.avatarUrl ?? null;
    }

    // ── 名片头部渲染 ──────────────────────────────────────────
    if (avatarUrl) {
      const isHttp = /^https?:\/\//i.test(avatarUrl);
      const isDataImage = /^data:image\/(?:png|jpeg|jpg|gif|webp|svg\+xml);base64,/i.test(avatarUrl);
      if (isHttp || isDataImage) {
        const safeSrc = escapeHtmlAttr(avatarUrl);
        md.appendMarkdown(`<img src="${safeSrc}" width="32" height="32" /> &nbsp; `);
      }
    }

    if (profile) {
      let displayName: string;
      if (profile.builtIn === 'local') {
        displayName = t('Local');
      } else if (profile.builtIn === 'global') {
        displayName = t('Global');
      } else {
        displayName = profile.name;
      }
      const accountName = profile.gitName.trim() || displayName;
      const sourceBadge = source === 'local' ? ` (${t('local')})` : source === 'global' ? ` (${t('global')})` : '';
      const platformBadge = repoPlatform.platformLabel
        ? (repoPlatform.primaryRemoteName
            ? ` · ${t('{0} Repository ({1})', repoPlatform.platformLabel, repoPlatform.primaryRemoteName)}`
            : ` · ${t('{0} Repository', repoPlatform.platformLabel)}`)
        : '';
      md.appendMarkdown(`**${escapeMarkdown(accountName)}**${escapeMarkdown(sourceBadge)}${escapeMarkdown(platformBadge)}\n\n`);
      if (profile.gitEmail) {
        const safeEmail = profile.gitEmail.replace(/[`\\]/g, '\\$&');
        md.appendMarkdown(`\`${safeEmail}\`\n\n`);
      }
    } else if (svnStatus) {
      const account = svnStatus.username ?? (svnStatus.hasCachedCredentials ? t('Authenticated') : t('No account detected'));
      md.appendMarkdown(`$(account) **SVN: ${escapeMarkdown(account)}**\n\n`);
      if (svnStatus.realm || svnStatus.authKey) {
        const realmText = svnStatus.realm ?? svnStatus.authKey ?? '';
        md.appendMarkdown(`*${escapeMarkdown(realmText)}*\n\n`);
      }
    } else {
      md.appendMarkdown(`$(account) **${t('No profile')}**\n\n`);
      md.appendMarkdown(`${t('VersionDock: No Git identity configured — click to set one')}\n\n`);
    }

    md.appendMarkdown('---\n\n');

    // ── 远程托管账号列表（主远程置顶，次要关联远程跟进） ──────
    md.appendMarkdown(`**${t('Remote Accounts')}**\n\n`);

    const platformEntries: Array<{
      platform: 'github' | 'gitlab' | 'gitee';
      rank: number;
      render: () => void;
    }> = [
      {
        platform: 'gitee',
        rank: repoPlatform.platform === 'gitee' ? 2 : repoPlatform.secondaryPlatforms.some(s => s.platform === 'gitee') ? 1 : 0,
        render: () => {
          let suffix = '';
          if (repoPlatform.platform === 'gitee') {
            const tag = repoPlatform.primaryRemoteName ? t('Current Project ({0})', repoPlatform.primaryRemoteName) : t('Current Project');
            suffix = ` *(${escapeMarkdown(tag)})*`;
          } else {
            const sec = repoPlatform.secondaryPlatforms.find(s => s.platform === 'gitee');
            if (sec) {
              suffix = ` *(${escapeMarkdown(t('Linked Remote ({0})', sec.remoteName))})*`;
            }
          }
          if (gtAccount) {
            md.appendMarkdown(`- $(repo) Gitee: **@${escapeMarkdown(gtAccount.username)}**${suffix} $(${'check'})\n`);
          } else {
            md.appendMarkdown(`- $(repo) Gitee: *${t('Not connected')}*${suffix}\n`);
          }
        },
      },
      {
        platform: 'github',
        rank: repoPlatform.platform === 'github' ? 2 : repoPlatform.secondaryPlatforms.some(s => s.platform === 'github') ? 1 : 0,
        render: () => {
          let suffix = '';
          if (repoPlatform.platform === 'github') {
            const tag = repoPlatform.primaryRemoteName ? t('Current Project ({0})', repoPlatform.primaryRemoteName) : t('Current Project');
            suffix = ` *(${tag})*`;
          } else {
            const sec = repoPlatform.secondaryPlatforms.find(s => s.platform === 'github');
            if (sec) {
              suffix = ` *(${escapeMarkdown(t('Linked Remote ({0})', sec.remoteName))})*`;
            }
          }
          const ghUser = ghAccount?.username || githubSession?.account?.label;
          if (ghUser) {
            md.appendMarkdown(`- $(github) GitHub: **@${escapeMarkdown(ghUser)}**${suffix} $(${'check'})\n`);
          } else {
            md.appendMarkdown(`- $(github) GitHub: *${t('Not connected')}*${suffix}\n`);
          }
        },
      },
      {
        platform: 'gitlab',
        rank: repoPlatform.platform === 'gitlab' ? 2 : repoPlatform.secondaryPlatforms.some(s => s.platform === 'gitlab') ? 1 : 0,
        render: () => {
          let suffix = '';
          if (repoPlatform.platform === 'gitlab') {
            const tag = repoPlatform.primaryRemoteName ? t('Current Project ({0})', repoPlatform.primaryRemoteName) : t('Current Project');
            suffix = ` *(${tag})*`;
          } else {
            const sec = repoPlatform.secondaryPlatforms.find(s => s.platform === 'gitlab');
            if (sec) {
              suffix = ` *(${escapeMarkdown(t('Linked Remote ({0})', sec.remoteName))})*`;
            }
          }
          if (glAccounts.length > 0) {
            const label = glAccounts.length === 1 ? `@${escapeMarkdown(glAccounts[0].username)}` : t('{0} account(s) connected', glAccounts.length);
            md.appendMarkdown(`- $(repo) GitLab: **${label}**${suffix} $(${'check'})\n`);
          } else {
            md.appendMarkdown(`- $(repo) GitLab: *${t('Not connected')}*${suffix}\n`);
          }
        },
      },
    ];

    platformEntries.sort((a, b) => b.rank - a.rank);

    for (const entry of platformEntries) {
      entry.render();
    }

    md.appendMarkdown('\n---\n\n');

    if (allServices && allServices.length > 1) {
      const activeMeta = activeService && this.manager ? this.manager.getRepoMeta(activeService.repoId) : undefined;
      const currentName = activeMeta?.name ?? (activeService ? path.basename(activeService.rootPath) : '');
      const label = t('Multi-repository workspace ({0} repos) · Current: {1}', allServices.length, currentName);
      md.appendMarkdown(`$(repo) *${escapeMarkdown(label)}*\n\n`);
    }

    md.appendMarkdown(`[$(gear) ${t('Click to manage accounts and identities')}](command:versiondock.manageProfiles)`);

    return md;
  }

  private renderStatusBar(
    profile: GitProfile | undefined,
    source: 'active' | 'local' | 'global',
    version = this.refreshVersion,
    activeService?: GitService,
    allServices?: GitService[],
  ): void {
    if (!profile) { this.renderNoProfile(version, activeService, allServices); return; }

    let displayName: string;
    if (profile.builtIn === 'local') {
      displayName = t('Local');
    } else if (profile.builtIn === 'global') {
      displayName = t('Global');
    } else {
      displayName = profile.name;
    }

    const sourceBadge = source === 'local' ? ` (${t('local')})` : source === 'global' ? ` (${t('global')})` : '';
    const accountName = profile.gitName.trim() || displayName;
    this.statusBarItem.text = `$(account) Git: ${accountName}`;
    this.statusBarItem.tooltip =
      `${t('VersionDock Profile')}: ${profile.gitName} <${profile.gitEmail}>${sourceBadge}\n${t('Click to manage accounts and identities')}`;

    void this.buildProfileTooltip({ profile, source, activeService, allServices }).then(tooltip => {
      if (version === this.refreshVersion) {
        this.statusBarItem.tooltip = tooltip;
      }
    }).catch(() => {});
  }

  private formatBadges(...badges: Array<string | false>): string {
    return badges.filter(Boolean).join(` ${t('·')} `);
  }

  private renderNoProfile(
    version = this.refreshVersion,
    activeService?: GitService,
    allServices?: GitService[],
  ): void {
    this.statusBarItem.text = `$(account) Git: ${t('No profile')}`;
    this.statusBarItem.tooltip = t('VersionDock: No Git identity configured — click to set one');

    void this.buildProfileTooltip({ activeService, allServices }).then(tooltip => {
      if (version === this.refreshVersion) {
        this.statusBarItem.tooltip = tooltip;
      }
    }).catch(() => {});
  }

  // ── Main menu ────────────────────────────────────────────────────────────────

  async showMenu(): Promise<void> {
    const allServices = this.getAllServices();
    if (allServices.length === 0) {
      await this.showGitMenu();
      return;
    }
    const activeService = this.getActiveService(allServices) || allServices[0];
    if (activeService.kind === 'svn') {
      await this.showSvnMenu(activeService as SvnService, allServices);
      return;
    }
    await this.showGitMenu(activeService.rootPath, allServices);
  }

  private async showServiceMenu(service: GitService, allServices?: GitService[]): Promise<void> {
    if (service.kind === 'svn') {
      await this.showSvnMenu(service as SvnService, allServices);
    } else {
      await this.showGitMenu(service.rootPath, allServices);
    }
  }

  private async showAccountTargetMenu(services: GitService[]): Promise<void> {
    if (!this.manager) return;
    type AccountItem = vscode.QuickPickItem & { action?: () => Promise<void> };
    const uniqueServices = Array.from(new Map(services.map(service => [service.repoId, service])).values());
    const activeService = this.getActiveService(services);

    const details = await Promise.all(uniqueServices.map(async service => {
      const meta = this.manager?.getRepoMeta(service.repoId);
      if (!meta) return undefined;
      const isCurrentActive = activeService?.repoId === service.repoId;
      if (service.kind === 'svn') {
        const status = await (service as SvnService).getAuthenticationStatus().catch(() => undefined);
        return {
          service,
          meta,
          isCurrentActive,
          group: status?.realm ?? status?.authKey ?? t('SVN Accounts'),
          description: (status?.username ?? (status?.hasCachedCredentials ? t('Authenticated') : t('No account detected'))) + (isCurrentActive ? `  ·  ${t('Current active')}` : ''),
        };
      }
      const [result, platformInfo] = await Promise.all([
        this.profileService.getEffectiveProfile(service.rootPath),
        this.detectRepositoryPlatform(service),
      ]);
      const platformBadge = platformInfo.platformLabel
        ? (platformInfo.primaryRemoteName ? ` [${platformInfo.platformLabel} · ${platformInfo.primaryRemoteName}]` : ` [${platformInfo.platformLabel}]`)
        : '';
      const activeBadge = isCurrentActive ? `  ·  ${t('Current active')}` : '';
      return {
        service,
        meta,
        isCurrentActive,
        group: t('Git identities'),
        description: (result ? `${result.profile.gitName} <${result.profile.gitEmail}>` : t('No profile')) + platformBadge + activeBadge,
      };
    }));

    const resolved = details.filter((item): item is NonNullable<typeof item> => !!item)
      .sort((left, right) => left.group.localeCompare(right.group) || left.meta.name.localeCompare(right.meta.name));
    const items: AccountItem[] = [];
    let previousGroup = '';
    for (const item of resolved) {
      if (item.group !== previousGroup) {
        items.push(sep(item.group) as AccountItem);
        previousGroup = item.group;
      }
      items.push({
        label: `${item.isCurrentActive ? '$(check) ' : '$(repo) '}${formatRepoLabel(item.meta)}`,
        description: item.description,
        detail: item.meta.rootPath,
        action: async () => {
          this.lastSelectedRepoId = item.service.repoId;
          this.refresh();
          await this.showServiceMenu(item.service, services);
        },
      });
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: t('VersionDock — Version Control Accounts'),
      placeHolder: t('Select a repository account to manage…'),
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (pick?.action) await pick.action();
  }

  private async showGitMenu(repoPath?: string, allServices?: GitService[]): Promise<void> {
    const profiles = this.profileService.getProfiles();
    const activeId = this.profileService.getActiveProfileId();

    type MenuItem = vscode.QuickPickItem & { action: () => Thenable<void> | void };
    const items: MenuItem[] = [];

    // ── Named profiles ────────────────────────────────────────────────────────
    const namedProfiles = profiles.filter(p => !p.builtIn);
    items.push(sep(t('PROFILES')));
    if (namedProfiles.length > 0) {
      for (const p of namedProfiles) {
        const isActive = p.id === activeId;
        const badges = this.formatBadges(isActive && t('active'));
        items.push({
          label: `${isActive ? '$(check)' : '$(account)'} ${p.name}${badges ? `  ·  ${badges}` : ''}`,
          description: `${p.gitName} <${p.gitEmail}>`,
          action: () => this.showProfileActionMenu(p),
        });
      }
      items.push(sep());
    }

    // ── Local entry ───────────────────────────────────────────────────────────
    const localCreds = repoPath ? await this.profileService.readLocalCreds(repoPath) : undefined;
    const localIsActive = activeId === LOCAL_PROFILE_ID;
    {
      const badges = this.formatBadges(localIsActive && t('active'));
      const icon = localIsActive ? '$(check)' : '$(home)';
      items.push({
        label: `${icon} ${t('Local')}${badges ? `  ·  ${badges}` : ''}`,
        description: localCreds
          ? `${localCreds.gitName} <${localCreds.gitEmail}>  ·  ${t('from .git/config')}`
          : repoPath ? t('No local git identity in this repo') : t('No repo open'),
        action: () => this.showBuiltInActionMenu('local', localCreds),
      });
    }

    // ── Global entry ──────────────────────────────────────────────────────────
    const globalCreds = await this.profileService.readGlobalCreds();
    const globalIsActive = activeId === GLOBAL_PROFILE_ID;
    {
      const badges = this.formatBadges(globalIsActive && t('active'));
      const icon = globalIsActive ? '$(check)' : '$(globe)';
      items.push({
        label: `${icon} ${t('Global')}${badges ? `  ·  ${badges}` : ''}`,
        description: globalCreds
          ? `${globalCreds.gitName} <${globalCreds.gitEmail}>  ·  ${t('from ~/.gitconfig')}`
          : t('No global git identity configured'),
        action: () => this.showBuiltInActionMenu('global', globalCreds),
      });
    }

    items.push(
      sep(),
      { label: `$(add) ${t('New Profile…')}`, description: t('Create a new Git identity profile'), action: () => this.createProfile() },
    );

    // ── Switch repository entry (when multiple repositories exist) ────────────
    const activeMeta = repoPath && this.manager ? this.manager.getRepoMetas().find(m => m.rootPath === repoPath) : undefined;
    if (allServices && allServices.length > 1) {
      const activeName = activeMeta?.name ?? (repoPath ? path.basename(repoPath) : '');
      items.push({
        label: `$(arrow-swap) ${t('Switch to another repository…')}`,
        description: t('Current: {0}  ·  {1} repositories in workspace', activeName, allServices.length),
        action: () => this.showAccountTargetMenu(allServices),
      });
    }

    // ── Remote accounts ───────────────────────────────────────────────────────
    const activeService = allServices?.find(s => s.rootPath === repoPath) || this.getContextServices()[0];
    await this.appendRemoteAccountItems(items, activeService);

    const activeIndex = allServices && repoPath ? allServices.findIndex(s => s.rootPath === repoPath) : -1;
    let title: string;
    if (activeMeta && allServices && allServices.length > 1 && activeIndex >= 0) {
      title = t('VersionDock — Accounts & Identities: {0} ({1}/{2})', activeMeta.name, activeIndex + 1, allServices.length);
    } else if (activeMeta) {
      title = t('VersionDock — Accounts & Identities: {0}', activeMeta.name);
    } else {
      title = t('VersionDock — Accounts & Identities');
    }

    const pick = await vscode.window.showQuickPick(items, {
      title,
      matchOnDescription: true,
      matchOnDetail: true,
    }) as MenuItem | undefined;

    if (pick) await pick.action();
  }

  private async appendRemoteAccountItems(
    items: Array<vscode.QuickPickItem & { action?: () => Thenable<void> | void }>,
    activeService?: GitService,
  ): Promise<void> {
    if (!this.remoteService) return;

    items.push(sep(t('REMOTE ACCOUNTS')));

    const [githubSession, connected] = await Promise.all([
      this.remoteService.github.getSession({ createIfNone: false }).catch(() => undefined),
      this.remoteService.getConnectedAccounts().catch(() => [] as RemoteAccountInfo[]),
    ]);
    const repoPlatform = await this.detectRepositoryPlatform(activeService, connected);


    let ghAccount = connected.find(a => a.provider === 'github');
    if (!ghAccount && githubSession?.account?.label) {
      const username = githubSession.account.label;
      ghAccount = {
        provider: 'github',
        id: githubSession.account.id || username,
        username,
        avatarUrl: `https://avatars.githubusercontent.com/${encodeURIComponent(username)}`,
        host: 'https://github.com',
      };
    }
    const glAccounts = connected.filter(a => a.provider === 'gitlab');
    const gtAccount = connected.find(a => a.provider === 'gitee');

    const ghConnected = Boolean(ghAccount || githubSession);
    const glConnected = glAccounts.length > 0;
    const gtConnected = Boolean(gtAccount);

    const githubLabel = ghAccount
      ? `GitHub (${ghAccount.username})`
      : githubSession
        ? `GitHub (${githubSession.account.label})`
        : 'GitHub';

    const gitlabLabel = glAccounts.length === 1
      ? `GitLab (${glAccounts[0].username})`
      : 'GitLab';

    const giteeLabel = gtAccount
      ? `Gitee (@${gtAccount.username})`
      : 'Gitee';

    const getPlatformTag = (platform: 'github' | 'gitlab' | 'gitee'): { tag: string; rank: number } => {
      if (repoPlatform.platform === platform) {
        const text = repoPlatform.primaryRemoteName
          ? t('Current Project ({0})', repoPlatform.primaryRemoteName)
          : t('Current Project');
        return { tag: `  ·  ${text}`, rank: 2 };
      }
      const sec = repoPlatform.secondaryPlatforms.find(s => s.platform === platform);
      if (sec) {
        return { tag: `  ·  ${t('Linked Remote ({0})', sec.remoteName)}`, rank: 1 };
      }
      return { tag: '', rank: 0 };
    };

    const ghTagInfo = getPlatformTag('github');
    const glTagInfo = getPlatformTag('gitlab');
    const gtTagInfo = getPlatformTag('gitee');

    const githubDescription = (ghConnected
      ? `$(check) ${t('Connected')}`
      : t('Not connected')) + ghTagInfo.tag;

    const gitlabDescription = (glConnected
      ? (glAccounts.length > 1
          ? `$(check) ${t('{0} account(s) connected', glAccounts.length)}`
          : `$(check) ${t('Connected')}`)
      : t('Not connected')) + glTagInfo.tag;

    const giteeDescription = (gtConnected
      ? `$(check) ${t('Connected')}`
      : t('Not connected')) + gtTagInfo.tag;

    const githubDetail = ghAccount?.name
      ? `${ghAccount.name} (@${ghAccount.username})`
      : githubSession
        ? t('Connected as {0}. Click to manage account.', githubSession.account.label)
        : t('Use the VS Code GitHub authentication provider');

    const gitlabDetail = glConnected
      ? glAccounts.map(a => `${a.name || a.username} (${a.host})`).join(' • ')
      : t('Add, re-authenticate, or remove GitLab Personal Access Tokens');

    const giteeDetail = gtAccount?.name
      ? `${gtAccount.name} (@${gtAccount.username})`
      : gtAccount
        ? t('Connected as @{0}. Click to switch or manage account.', gtAccount.username)
        : t('Connect using a Gitee Personal Access Token');

    const [ghIconUri, glIconUri, gtIconUri] = await Promise.all([
      ghAccount?.avatarUrl ? this.remoteService.avatarService.getLocalAvatarUri(ghAccount.avatarUrl) : undefined,
      glAccounts[0]?.avatarUrl ? this.remoteService.avatarService.getLocalAvatarUri(glAccounts[0].avatarUrl) : undefined,
      gtAccount?.avatarUrl ? this.remoteService.avatarService.getLocalAvatarUri(gtAccount.avatarUrl) : undefined,
    ]);

    type RemoteItem = vscode.QuickPickItem & { action?: () => Thenable<void> | void; rank: number };

    const platformItems: RemoteItem[] = [
      {
        label: ghIconUri ? githubLabel : `$(github) ${githubLabel}`,
        description: githubDescription,
        detail: githubDetail,
        iconPath: ghIconUri,
        rank: ghTagInfo.rank,
        action: () => this.remoteService!.manageGitHubAccount(githubSession),
      },
      {
        label: glIconUri ? gitlabLabel : `$(repo) ${gitlabLabel}`,
        description: gitlabDescription,
        detail: gitlabDetail,
        iconPath: glIconUri,
        rank: glTagInfo.rank,
        action: () => this.remoteService!.gitlab.manageAccounts(),
      },
      {
        label: gtIconUri ? giteeLabel : `$(repo) ${giteeLabel}`,
        description: giteeDescription,
        detail: giteeDetail,
        iconPath: gtIconUri,
        rank: gtTagInfo.rank,
        action: () => this.remoteService!.gitee.manageAccounts(),
      },
    ];

    platformItems.sort((a, b) => b.rank - a.rank);

    items.push(...platformItems);

    items.push({
      label: `$(trash) ${t('Clear Avatar Cache')}`,
      description: t('Cache'),
      detail: t('Purge cached avatars and force reload'),
      action: () => {
        this.remoteService!.clearAvatarCache();
        this.refresh();
        void vscode.window.showInformationMessage(t('VersionDock: Avatar cache cleared.'));
      },
    });
  }

  private async showSvnMenu(service: SvnService, allServices?: GitService[]): Promise<void> {
    const meta = this.manager?.getRepoMeta(service.repoId);
    if (!meta) return;
    const [status, info] = await Promise.all([
      service.getAuthenticationStatus().catch(() => ({ source: 'unknown', hasCachedCredentials: false } as SvnAuthenticationStatus)),
      service.inspectRepositoryInfo(),
    ]);

    type ActionItem = vscode.QuickPickItem & { action: () => Thenable<void> | void };
    const account = status.username ?? (status.hasCachedCredentials ? t('Authenticated') : t('No account detected'));
    const source = this.getSvnAuthenticationSourceLabel(status.source);
    const items: ActionItem[] = [];
    if (allServices && allServices.length > 1) {
      items.push(
        { label: `$(arrow-swap) ${t('Switch to another repository…')}`, description: t('Select a repository to manage its identity'), action: () => this.showAccountTargetMenu(allServices) },
        sep() as ActionItem,
      );
    }
    items.push(
      sep(t('CURRENT SVN ACCOUNT')) as ActionItem,
      {
        label: `$(account) ${account}`,
        description: source,
        detail: status.realm ?? status.authKey,
        action: () => this.promptSvnAuthentication(service, status),
      },
    );

    if (info?.url) {
      items.push({
        label: `$(link) ${t('Repository URL')}`,
        description: info.url,
        detail: info.rootUrl,
        action: async () => {
          await vscode.env.clipboard.writeText(info.url);
          vscode.window.showInformationMessage(t('VersionDock [{0}]: SVN repository URL copied.', meta.name));
        },
      });
    }

    items.push(
      sep(t('ACTIONS')) as ActionItem,
      { label: `$(account) ${t('Switch SVN Account…')}`, description: t('Enter another username and password for this authentication realm'), action: () => this.promptSvnAuthentication(service, status, meta) },
      { label: `$(refresh) ${t('Re-authenticate…')}`, description: t('Forget the current session account and enter credentials again'), action: async () => { await service.forgetSessionAuthentication(); await this.promptSvnAuthentication(service, status, meta); } },
      { label: `$(debug-disconnect) ${t('Forget Session Credentials')}`, description: t('Keep the system SVN cache, but forget credentials held by VersionDock'), action: () => this.forgetSvnSession(service, meta) },
      { label: `$(trash) ${t('Clear Cached SVN Credentials…')}`, description: t('Remove matching credentials from the system SVN authentication cache'), action: () => this.clearSvnAuthentication(service, meta, status) },
      { label: `$(plug) ${t('Test SVN Connection')}`, description: t('Run svn info using the current account'), action: () => this.testSvnConnection(service, meta) },
    );

    await this.appendRemoteAccountItems(items);

    const pick = await vscode.window.showQuickPick(items, {
      title: t('VersionDock — SVN Account: {0}', meta.name),
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (pick) await pick.action();
  }

  private getSvnAuthenticationSourceLabel(source: SvnAuthenticationStatus['source']): string {
    if (source === 'session') return t('VersionDock session credentials');
    if (source === 'svn-scm') return t('VS Code SVN credentials');
    if (source === 'native-cache') return t('System SVN authentication cache');
    return t('No cached SVN credentials detected');
  }

  private async promptSvnAuthentication(service: SvnService, status: SvnAuthenticationStatus, meta?: RepoMeta): Promise<void> {
    const username = await vscode.window.showInputBox({
      title: t('Switch SVN Account'),
      prompt: t('SVN username for {0}', status.realm ?? status.authKey ?? service.rootPath),
      value: status.username ?? '',
      placeHolder: t('Username'),
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : t('SVN username cannot be empty.'),
    });
    if (username === undefined) return;

    const password = await vscode.window.showInputBox({
      title: t('Switch SVN Account'),
      prompt: t('Password for SVN account {0}', username.trim()),
      placeHolder: t('Password'),
      password: true,
      ignoreFocusOut: true,
      validateInput: value => value ? undefined : t('SVN password cannot be empty.'),
    });
    if (password === undefined) return;

    const rememberPick = await vscode.window.showQuickPick([
      { label: `$(lock) ${t('Remember in SVN authentication cache')}`, description: t('Other SVN clients can reuse this account'), remember: true },
      { label: `$(clock) ${t('Use for this VersionDock session only')}`, description: t('Do not write the password to the system SVN cache'), remember: false },
    ], { title: t('Save SVN credentials?') });
    if (!rememberPick) return;

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: meta ? t('VersionDock [{0}]: Verifying SVN account…', meta.name) : t('VersionDock: Verifying SVN account…'), cancellable: false },
        () => service.switchAuthentication(username, password, rememberPick.remember),
      );
      this.refresh();
      vscode.window.showInformationMessage(
        meta
          ? t('VersionDock [{0}]: SVN account switched to {1}.', meta.name, username.trim())
          : t('VersionDock: SVN account switched to {0}.', username.trim())
      );
    } catch (error: unknown) {
      vscode.window.showErrorMessage(
        meta
          ? t('VersionDock [{0}]: SVN authentication failed: {1}', meta.name, String(error))
          : t('VersionDock: SVN authentication failed: {0}', String(error))
      );
    }
  }

  private async forgetSvnSession(service: SvnService, meta?: RepoMeta): Promise<void> {
    await service.forgetSessionAuthentication();
    this.refresh();
    vscode.window.showInformationMessage(
      meta
        ? t('VersionDock [{0}]: SVN session credentials forgotten.', meta.name)
        : t('VersionDock: SVN session credentials forgotten.')
    );
  }

  private async clearSvnAuthentication(service: SvnService, meta: RepoMeta, status: SvnAuthenticationStatus): Promise<void> {
    const pattern = status.realm ?? status.authKey;
    const action = t('Clear Cached Credentials');
    const confirmed = await vscode.window.showWarningMessage(
      t('VersionDock [{0}]: Clear cached SVN credentials for {1}? This can affect other SVN clients using the same authentication realm.', meta.name, pattern ?? meta.name),
      { modal: true },
      action,
    );
    if (confirmed !== action) return;
    try {
      await service.clearCachedAuthentication();
      this.refresh();
      vscode.window.showInformationMessage(t('VersionDock [{0}]: Cached SVN credentials cleared.', meta.name));
    } catch (error: unknown) {
      vscode.window.showErrorMessage(t('VersionDock [{0}]: Failed to clear SVN credentials: {1}', meta.name, String(error)));
    }
  }

  private async testSvnConnection(service: SvnService, meta: RepoMeta): Promise<void> {
    try {
      const info = await service.testAuthentication();
      vscode.window.showInformationMessage(t('VersionDock [{0}]: SVN connection succeeded: {1}', meta.name, info.url));
    } catch (error: unknown) {
      vscode.window.showErrorMessage(t('VersionDock [{0}]: SVN connection failed: {1}', meta.name, String(error)));
    }
  }

  // ── Built-in (Local / Global) action menu ────────────────────────────────────

  private async showBuiltInActionMenu(
    type: 'local' | 'global',
    creds: { gitName: string; gitEmail: string } | undefined,
  ): Promise<void> {
    const id = type === 'local' ? LOCAL_PROFILE_ID : GLOBAL_PROFILE_ID;
    const label = type === 'local' ? t('Local') : t('Global');
    const activeId = this.profileService.getActiveProfileId();
    const isActive = activeId === id;

    type ActionItem = vscode.QuickPickItem & { action: () => Thenable<void> | void };
    const items: ActionItem[] = [
      { label: `$(arrow-left) ${t('Back')}`, action: () => this.showMenu() },
      sep() as unknown as ActionItem,
    ];

    if (!isActive) {
      items.push({
        label: `$(check) ${t('Use for this workspace')}`,
        description: t('Set {0} as active profile for this workspace', label),
        action: async () => {
          await this.profileService.setActiveProfile(id);
          this.refresh();
          vscode.window.showInformationMessage(t('VersionDock: {0} set as active profile for this workspace.', label));
        },
      });
    } else {
      items.push({
        label: `$(check) ${t('Active (in use)')}`,
        description: t('{0} is the active profile for this workspace', label),
        action: async () => { await this.showMenu(); },
      });
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: creds ? t('{0} — {1}', label, `${creds.gitName} <${creds.gitEmail}>`) : label,
      matchOnDescription: true,
    }) as ActionItem | undefined;

    if (pick) await pick.action();
  }

  // ── Named profile action menu ─────────────────────────────────────────────────

  private async showProfileActionMenu(profile: GitProfile): Promise<void> {
    const activeId = this.profileService.getActiveProfileId();
    const isActive = profile.id === activeId;

    type ActionItem = vscode.QuickPickItem & { action: () => Thenable<void> | void };
    const items: ActionItem[] = [
      { label: `$(arrow-left) ${t('Back')}`, action: () => this.showMenu() },
      sep() as unknown as ActionItem,
    ];

    if (!isActive) {
      items.push({
        label: `$(check) ${t('Use for this project/workspace')}`,
        description: t('Use "{0}" for commits made by VersionDock in this workspace', profile.name),
        action: () => this.activateProfile(profile),
      });
    } else {
      items.push({
        label: `$(check) ${t('Active (in use)')}`,
        description: t('This profile is active for this workspace'),
        action: async () => { await this.showMenu(); },
      });
    }

    items.push(
      sep() as unknown as ActionItem,
      { label: `$(edit) ${t('Edit…')}`, action: () => this.editProfile(profile) },
      { label: `$(trash) ${t('Delete')}`, description: t('Remove "{0}"', profile.name), action: () => this.deleteProfile(profile) },
    );

    const pick = await vscode.window.showQuickPick(items, {
      title: t('Profile: {0}', profile.name),
      matchOnDescription: true,
    }) as ActionItem | undefined;

    if (pick) await pick.action();
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────────

  private async activateProfile(profile: GitProfile): Promise<void> {
    await this.profileService.setActiveProfile(profile.id);
    this.refresh();
    vscode.window.showInformationMessage(t('VersionDock: "{0}" is now active.', profile.name));
  }

  async createProfile(): Promise<void> {
    const displayName = await vscode.window.showInputBox({
      title: t('New Git Profile — Display Name'),
      prompt: t('A label for this profile (e.g. Work, Personal)'),
      placeHolder: t('Work'),
      validateInput: v => {
        if (!v.trim()) return t('Name cannot be empty');
        if (['local', 'global'].includes(v.trim().toLowerCase())) return t('"{0}" is a reserved name', v.trim());
        return undefined;
      },
    });
    if (!displayName) return;

    const gitName = await vscode.window.showInputBox({
      title: t('New Git Profile — Git Name'),
      prompt: t('Value for git user.name'),
      placeHolder: t('John Doe'),
    });
    if (gitName === undefined) return;

    const gitEmail = await vscode.window.showInputBox({
      title: t('New Git Profile — Git Email'),
      prompt: t('Value for git user.email'),
      placeHolder: t('john@example.com'),
      validateInput: v => (v.trim() ? undefined : t('Email cannot be empty')),
    });
    if (!gitEmail) return;

    const profile: GitProfile = {
      id: generateId(),
      name: displayName.trim(),
      gitName: gitName.trim(),
      gitEmail: gitEmail.trim(),
    };

    await this.profileService.saveProfile(profile);

    const activatePick = await vscode.window.showQuickPick(
      [
        { label: `$(check) ${t('Yes, use it now')}`, value: true },
        { label: `$(close) ${t('No, just save it')}`, value: false },
      ],
      { title: t('Profile "{0}" created — activate for this workspace?', profile.name) }
    ) as { label: string; value: boolean } | undefined;

    if (activatePick?.value) {
      await this.profileService.setActiveProfile(profile.id);
    }

    this.refresh();
  }

  private async editProfile(profile: GitProfile): Promise<void> {
    const displayName = await vscode.window.showInputBox({
      title: t('Edit Profile — Display Name'),
      value: profile.name,
      validateInput: v => {
        if (!v.trim()) return t('Name cannot be empty');
        if (['local', 'global'].includes(v.trim().toLowerCase())) return t('"{0}" is a reserved name', v.trim());
        return undefined;
      },
    });
    if (!displayName) return;

    const gitName = await vscode.window.showInputBox({ title: t('Edit Profile — Git Name'), value: profile.gitName });
    if (gitName === undefined) return;

    const gitEmail = await vscode.window.showInputBox({
      title: t('Edit Profile — Git Email'),
      value: profile.gitEmail,
      validateInput: v => (v.trim() ? undefined : t('Email cannot be empty')),
    });
    if (!gitEmail) return;

    await this.profileService.saveProfile({ ...profile, name: displayName.trim(), gitName: gitName.trim(), gitEmail: gitEmail.trim() });
    this.refresh();
    vscode.window.showInformationMessage(t('VersionDock: Profile "{0}" updated.', displayName));
  }

  private async deleteProfile(profile: GitProfile): Promise<void> {
    const confirm = await vscode.window.showQuickPick(
      [{ label: `$(trash) ${t('Delete')}`, value: true }, { label: `$(close) ${t('Cancel')}`, value: false }],
      { title: t('Delete profile "{0}"?', profile.name) }
    ) as { label: string; value: boolean } | undefined;

    if (!confirm?.value) return;
    await this.profileService.deleteProfile(profile.id);
    this.refresh();
    vscode.window.showInformationMessage(t('VersionDock: Profile "{0}" deleted.', profile.name));
  }

  // ── Command palette: switch ───────────────────────────────────────────────────

  async switchProfile(): Promise<void> {
    const profiles = this.profileService.getProfiles().filter(p => !p.builtIn);
    if (profiles.length === 0) {
      const create = await vscode.window.showWarningMessage(t('VersionDock: No profiles configured.'), t('Create Profile'));
      if (create) await this.createProfile();
      return;
    }

    const activeId = this.profileService.getActiveProfileId();
    type Item = vscode.QuickPickItem & { id: string };
    const items: Item[] = profiles.map(p => ({
      label: `${p.id === activeId ? '$(check) ' : '$(account) '}${p.name}`,
      description: `${p.gitName} <${p.gitEmail}>`,
      id: p.id,
    }));

    const pick = await vscode.window.showQuickPick(items, {
      title: t('VersionDock — Switch Git Profile'),
      matchOnDescription: true,
    }) as Item | undefined;

    if (!pick) return;
    await this.profileService.setActiveProfile(pick.id);
    const selected = profiles.find(p => p.id === pick.id);
    if (selected) {
      this.refresh();
      vscode.window.showInformationMessage(t('VersionDock: "{0}" is now active.', selected.name));
    }
  }

  dispose(): void {
    this.statusBarItem.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}

function sep(label = ''): vscode.QuickPickItem & { action: () => void } {
  return { label, kind: vscode.QuickPickItemKind.Separator, action: () => undefined };
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
