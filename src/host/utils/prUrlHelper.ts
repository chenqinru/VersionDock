export interface PrUrlInfo {
  platform: 'GitHub' | 'GitLab' | 'Gitee' | 'Bitbucket' | 'Unknown';
  url: string;
}

/**
 * Parses a Git remote URL (SSH or HTTPS) and generates a web URL to create a Pull Request / Merge Request.
 */
export function buildPullRequestUrl(remoteUrl: string, branchName: string): PrUrlInfo | undefined {
  if (!remoteUrl || !branchName || branchName === 'HEAD' || branchName.startsWith('refs/')) {
    return undefined;
  }

  const cleanUrl = remoteUrl.trim();
  let host = '';
  let repoPath = '';

  // Case 1: SCP-like syntax: git@github.com:owner/repo.git
  const scpMatch = cleanUrl.match(/^[\w\-.]+@([\w\-.]+):(.+?)(?:\.git)?$/);
  if (scpMatch) {
    host = scpMatch[1].toLowerCase();
    repoPath = scpMatch[2].replace(/^\/+|\/+$/g, '');
  } else {
    // Case 2: URL syntax: https://github.com/owner/repo.git or ssh://git@gitlab.com/...
    try {
      const parsed = new URL(cleanUrl);
      host = parsed.hostname.toLowerCase();
      repoPath = parsed.pathname.replace(/^\/+|\.git$/g, '').replace(/^\/+|\/+$/g, '');
    } catch {
      return undefined;
    }
  }

  if (!host || !repoPath) return undefined;

  const encodedBranch = encodeURIComponent(branchName);

  if (host === 'github.com' || host.includes('github')) {
    return {
      platform: 'GitHub',
      url: `https://${host}/${repoPath}/pull/new/${encodedBranch}`,
    };
  }

  if (host === 'gitlab.com' || host.includes('gitlab')) {
    return {
      platform: 'GitLab',
      url: `https://${host}/${repoPath}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodedBranch}`,
    };
  }

  if (host === 'gitee.com' || host.includes('gitee')) {
    return {
      platform: 'Gitee',
      url: `https://${host}/${repoPath}/pull/new?source_branch=${encodedBranch}`,
    };
  }

  if (host === 'bitbucket.org' || host.includes('bitbucket')) {
    return {
      platform: 'Bitbucket',
      url: `https://${host}/${repoPath}/pull-requests/new?source=${encodedBranch}`,
    };
  }

  return undefined;
}
