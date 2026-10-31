export interface SvnWorkingCopyCandidate {
  repoId: string;
  repositoryUuid?: string;
}

/**
 * Group SVN working copies that belong to the same repository so their selected
 * files can be committed as one revision. Working copies without a resolved
 * repository UUID or without a peer are absent from the result and keep their
 * own commit.
 */
export function groupSvnWorkingCopiesByUuid(
  candidates: readonly SvnWorkingCopyCandidate[],
): Map<string, string[]> {
  const repoIdsByUuid = new Map<string, string[]>();
  for (const candidate of candidates) {
    const uuid = candidate.repositoryUuid?.trim();
    if (!uuid) continue;
    const repoIds = repoIdsByUuid.get(uuid);
    if (repoIds) repoIds.push(candidate.repoId);
    else repoIdsByUuid.set(uuid, [candidate.repoId]);
  }

  const groups = new Map<string, string[]>();
  for (const repoIds of repoIdsByUuid.values()) {
    if (repoIds.length < 2) continue;
    for (const repoId of repoIds) groups.set(repoId, repoIds);
  }
  return groups;
}
