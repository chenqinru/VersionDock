import type { CommitNode, GraphLine } from '../../shared/types';
import { anonymousLaneColor } from './refs';
import { headColor, primaryBranchColor, currentPalette, branchPaletteIndex } from '../../shared/branchColors';
import { isPrimaryBranch } from '../../shared/branchUtils';

export const LANE_WIDTH = 20;
export const ROW_HEIGHT = 28;
export const DOT_RADIUS = 4;

export interface LaidOutCommit extends CommitNode {
  lane: number;
  totalLanes: number;
  graphLines: GraphLine[];
  dotColor: string;
}

// Extract the branch name that "owns" a commit from its refs array.
// Priority: HEAD → local branch → remote branch → tag.
// Returns null for commits with no refs (middle-of-branch commits).
function primaryRefName(refs: string[]): string | null {
  for (const r of refs) {
    if (r.startsWith('HEAD -> ')) return r.slice('HEAD -> '.length);
  }
  for (const r of refs) {
    if (!r.startsWith('HEAD') && !r.startsWith('tag: ') && !r.includes('/')) return r;
  }
  for (const r of refs) {
    if (!r.startsWith('HEAD') && !r.startsWith('tag: ') && r.includes('/')) return r;
  }
  for (const r of refs) {
    if (r.startsWith('tag: ')) return r.slice('tag: '.length);
  }
  return null;
}

// Returns true if this commit has a ref that is a primary branch (main/master/…).
function hasPrimaryBranchRef(refs: string[]): boolean {
  for (const r of refs) {
    let name = r;
    if (name.startsWith('HEAD -> ')) name = name.slice('HEAD -> '.length);
    else if (name === 'HEAD' || name.startsWith('tag: ')) continue;
    else if (name.includes('/')) name = name.slice(name.indexOf('/') + 1);
    if (isPrimaryBranch(name)) return true;
  }
  return false;
}

// Walk the first-parent chain from a starting commit, returning every hash.
function firstParentChain(startIdx: number, commits: CommitNode[], hashIndex: Map<string, number>): Set<string> {
  const chain = new Set<string>();
  let idx = startIdx;
  while (idx >= 0 && idx < commits.length) {
    const hash = commits[idx].hash;
    if (chain.has(hash)) break; // cycle guard
    chain.add(hash);
    const p0 = commits[idx].parents[0];
    if (!p0) break;
    idx = hashIndex.get(p0) ?? -1;
  }
  return chain;
}

interface FirstParentIndex {
  rootOf: Map<string, string>;
  tin: Map<string, number>;
  tout: Map<string, number>;
}

function buildFirstParentIndex(commits: CommitNode[]): FirstParentIndex {
  const visibleHashes = new Set(commits.map(c => c.hash));
  const childrenByParent = new Map<string, string[]>();
  const hasVisibleFirstParent = new Set<string>();

  for (const commit of commits) {
    const firstParent = commit.parents[0];
    if (!firstParent || !visibleHashes.has(firstParent)) continue;
    const children = childrenByParent.get(firstParent) ?? [];
    children.push(commit.hash);
    childrenByParent.set(firstParent, children);
    hasVisibleFirstParent.add(commit.hash);
  }

  const rootOf = new Map<string, string>();
  const tin = new Map<string, number>();
  const tout = new Map<string, number>();
  const state = new Map<string, 0 | 1 | 2>();
  let time = 0;

  function visit(rootHash: string): void {
    const stack: Array<{ hash: string; childIndex: number; entered: boolean }> = [
      { hash: rootHash, childIndex: 0, entered: false },
    ];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const currentState = state.get(frame.hash) ?? 0;

      if (!frame.entered) {
        if (currentState === 2) {
          stack.pop();
          continue;
        }
        if (currentState === 1) {
          tout.set(frame.hash, time);
          state.set(frame.hash, 2);
          stack.pop();
          continue;
        }
        state.set(frame.hash, 1);
        rootOf.set(frame.hash, rootHash);
        tin.set(frame.hash, time++);
        frame.entered = true;
      }

      const children = childrenByParent.get(frame.hash) ?? [];
      let pushed = false;
      while (frame.childIndex < children.length) {
        const child = children[frame.childIndex++];
        if ((state.get(child) ?? 0) !== 0) continue;
        stack.push({ hash: child, childIndex: 0, entered: false });
        pushed = true;
        break;
      }

      if (!pushed) {
        tout.set(frame.hash, time);
        state.set(frame.hash, 2);
        stack.pop();
      }
    }
  }

  for (const commit of commits) {
    if (!hasVisibleFirstParent.has(commit.hash)) visit(commit.hash);
  }
  for (const commit of commits) {
    if ((state.get(commit.hash) ?? 0) === 0) visit(commit.hash);
  }

  return { rootOf, tin, tout };
}

function firstParentReaches(index: FirstParentIndex, startHash: string, targetHash: string): boolean {
  const startRoot = index.rootOf.get(startHash);
  if (!startRoot || startRoot !== index.rootOf.get(targetHash)) return false;

  const startTin = index.tin.get(startHash);
  const startTout = index.tout.get(startHash);
  const targetTin = index.tin.get(targetHash);
  const targetTout = index.tout.get(targetHash);
  if (startTin === undefined || startTout === undefined || targetTin === undefined || targetTout === undefined) {
    return false;
  }

  return targetTin <= startTin && startTout <= targetTout;
}

// Circular distance between two palette indices.
function paletteDist(a: number, b: number, n: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, n - d);
}

// Given a preferred starting index and the set of palette indices already used
// by active lanes, return the index that:
//   1. Maximises the minimum circular distance from all used indices.
//   2. Breaks ties by preferring the index closest to `preferred` (stable naming).
function pickPaletteIndex(preferred: number, usedIndices: Set<number>): number {
  const palette = currentPalette();
  const n = palette.length;

  if (usedIndices.size === 0) return preferred;

  let bestIdx = preferred;
  let bestMinDist = -1;

  for (let i = 0; i < n; i++) {
    // Min distance from this candidate to any used index.
    let minDist = n;
    for (const u of usedIndices) {
      const d = paletteDist(i, u, n);
      if (d < minDist) minDist = d;
    }
    // Prefer: larger minDist first; same minDist → closer to preferred.
    if (
      minDist > bestMinDist ||
      (minDist === bestMinDist && paletteDist(i, preferred, n) < paletteDist(bestIdx, preferred, n))
    ) {
      bestMinDist = minDist;
      bestIdx = i;
    }
  }

  return bestIdx;
}

export function assignLanes(commits: CommitNode[], _isFiltered = false): LaidOutCommit[] {
  // The log is rendered from a finite window: pagination, graphMaxCommits, or
  // filters can leave parent commits outside the current list. Keeping those
  // invisible parents reserved in laneOf makes occupied lanes impossible to
  // close, so the graph keeps allocating lanes to the right.
  const visibleHashes = new Set(commits.map(c => c.hash));
  commits = commits.map(c => ({
    ...c,
    parents: c.parents.filter(p => visibleHashes.has(p)),
  }));

  // Build a hash→index lookup for chain walking.
  const hashIndex = new Map<string, number>();
  for (let i = 0; i < commits.length; i++) hashIndex.set(commits[i].hash, i);
  const firstParentIndex = buildFirstParentIndex(commits);

  // Identify the set of hashes that belong to the primary branch's first-parent
  // chain. These commits will be forced onto lane 0 when they are first seen,
  // overriding nextFreeLane() which would otherwise give lane 0 to whoever
  // happens to appear first in the list (e.g. a feature branch at HEAD).
  const primaryStartIdx = commits.findIndex(c => hasPrimaryBranchRef(c.refs));
  const primaryChain: Set<string> = primaryStartIdx >= 0
    ? firstParentChain(primaryStartIdx, commits, hashIndex)
    : new Set();

  // laneOf: parent-hash → lane index reserved by one of its children.
  const laneOf = new Map<string, number>();
  // laneColorOf: lane → resolved color string.
  const laneColorOf = new Map<number, string>();
  // lanePaletteIdx: lane → palette index currently assigned to that lane.
  const lanePaletteIdx = new Map<number, number>();
  // laneTargetHash: lane → next visible commit hash this lane is waiting to reach.
  const laneTargetHash = new Map<number, string>();
  // occupied: lane indices that have an active "thread" going downward.
  const occupied = new Set<number>();
  const laidOut: LaidOutCommit[] = [];

  // Returns the set of palette indices currently in use by occupied lanes.
  function usedPaletteIndices(): Set<number> {
    const s = new Set<number>();
    for (const l of occupied) {
      const idx = lanePaletteIdx.get(l);
      if (idx !== undefined) s.add(idx);
    }
    return s;
  }

  // Assign a color to a lane, choosing the palette index that is maximally
  // distant from all currently occupied lanes' indices.
  // For named branches: preferred index comes from the branch name hash.
  // For anonymous lanes: preferred index is based on lane number.
  function assignLaneColor(lane: number, refName: string | null, isHeadCommit: boolean): void {
    const palette = currentPalette();

    // Fixed colors for primary and HEAD — not from palette.
    if (refName !== null) {
      const norm = refName.replace(/^[^/]+\//, '');
      if (isPrimaryBranch(norm)) {
        laneColorOf.set(lane, primaryBranchColor());
        // Use a virtual index outside palette range so it doesn't affect spacing.
        lanePaletteIdx.set(lane, -1);
        return;
      }
      if (isHeadCommit) {
        laneColorOf.set(lane, headColor());
        lanePaletteIdx.set(lane, -2);
        return;
      }
    }

    const preferred = refName !== null
      ? branchPaletteIndex(refName)
      : lane % palette.length;

    // Exclude this lane's own current index so it can shift if needed.
    const used = usedPaletteIndices();
    used.delete(lanePaletteIdx.get(lane) ?? -99);

    const chosen = pickPaletteIndex(preferred, used);
    lanePaletteIdx.set(lane, chosen);
    laneColorOf.set(lane, palette[chosen]);
  }

  function nextFreeLane(preferZero = false): number {
    if (preferZero && !occupied.has(0)) return 0;
    let i = 0;
    while (occupied.has(i)) i++;
    return i;
  }

  function reserveLane(lane: number, targetHash: string): void {
    const previousTarget = laneTargetHash.get(lane);
    if (previousTarget !== undefined) laneOf.delete(previousTarget);
    laneOf.set(targetHash, lane);
    laneTargetHash.set(lane, targetHash);
  }

  function clearLane(lane: number): void {
    const targetHash = laneTargetHash.get(lane);
    if (targetHash !== undefined) laneOf.delete(targetHash);
    laneTargetHash.delete(lane);
    occupied.delete(lane);
    laneColorOf.delete(lane);
    lanePaletteIdx.delete(lane);
  }

  function consumeLaneTarget(lane: number, targetHash: string): void {
    laneOf.delete(targetHash);
    if (laneTargetHash.get(lane) === targetHash) laneTargetHash.delete(lane);
  }

  function findReachableLane(targetHash: string): number | null {
    let best: number | null = null;
    for (const [lane, currentTarget] of laneTargetHash) {
      if (!occupied.has(lane)) continue;
      if (!firstParentReaches(firstParentIndex, currentTarget, targetHash)) continue;
      if (best === null || lane < best) best = lane;
    }
    return best;
  }

  function compactLanes(): Map<number, number> {
    const lanes = Array.from(occupied).sort((a, b) => a - b);
    const laneMap = new Map<number, number>();
    let changed = false;

    for (let i = 0; i < lanes.length; i++) {
      const oldLane = lanes[i];
      laneMap.set(oldLane, i);
      if (oldLane !== i) changed = true;
    }

    if (!changed) return laneMap;

    const nextOccupied = new Set<number>();
    const nextLaneTargetHash = new Map<number, string>();
    const nextLaneColorOf = new Map<number, string>();
    const nextLanePaletteIdx = new Map<number, number>();

    for (const oldLane of lanes) {
      const newLane = laneMap.get(oldLane)!;
      nextOccupied.add(newLane);

      const targetHash = laneTargetHash.get(oldLane);
      if (targetHash !== undefined) nextLaneTargetHash.set(newLane, targetHash);

      const color = laneColorOf.get(oldLane);
      if (color !== undefined) nextLaneColorOf.set(newLane, color);

      const paletteIdx = lanePaletteIdx.get(oldLane);
      if (paletteIdx !== undefined) nextLanePaletteIdx.set(newLane, paletteIdx);
    }

    occupied.clear();
    for (const lane of nextOccupied) occupied.add(lane);

    laneTargetHash.clear();
    for (const [lane, targetHash] of nextLaneTargetHash) laneTargetHash.set(lane, targetHash);

    laneColorOf.clear();
    for (const [lane, color] of nextLaneColorOf) laneColorOf.set(lane, color);

    lanePaletteIdx.clear();
    for (const [lane, paletteIdx] of nextLanePaletteIdx) lanePaletteIdx.set(lane, paletteIdx);

    laneOf.clear();
    for (const [lane, targetHash] of laneTargetHash) laneOf.set(targetHash, lane);

    return laneMap;
  }

  for (const commit of commits) {
    // ── Step 1: find this commit's lane ──────────────────────────────────────
    let lane: number;
    let isStart: boolean;

    if (laneOf.has(commit.hash)) {
      // This commit was already claimed by one of its children.
      lane = laneOf.get(commit.hash)!;
      isStart = false;
      consumeLaneTarget(lane, commit.hash);
    } else {
      // New thread: pick lane 0 if this commit is on the primary chain and
      // lane 0 is free, otherwise pick the next available lane.
      const wantPrimary = primaryChain.has(commit.hash);
      lane = nextFreeLane(wantPrimary);
      isStart = true;
      occupied.add(lane);
    }

    // ── Assign / update branch name and color for this lane ──────────────────
    const refName = primaryRefName(commit.refs);
    const isHeadCommit = commit.refs.some(r => r.startsWith('HEAD -> ') || r === 'HEAD');
    if (isStart || refName !== null) {
      assignLaneColor(lane, refName, isHeadCommit);
    }
    const currentLaneColor = laneColorOf.get(lane) ?? anonymousLaneColor(lane);

    // ── Step 2: snapshot lanes active *entering* this row ────────────────────
    const enteringLanes = new Set(occupied);

    // ── Step 3: assign lanes to parents ──────────────────────────────────────
    const parentLanes: number[] = [];

    for (let i = 0; i < commit.parents.length; i++) {
      const parentHash = commit.parents[i];

      if (i === 0) {
        if (laneOf.has(parentHash)) {
          // Parent already claimed by another child (diamond merge).
          // Our lane thread ends here.
          parentLanes.push(laneOf.get(parentHash)!);
          clearLane(lane);
        } else {
          reserveLane(lane, parentHash);
          parentLanes.push(lane);
        }
      } else {
        // Secondary (merge) parent.
        if (laneOf.has(parentHash)) {
          parentLanes.push(laneOf.get(parentHash)!);
        } else {
          const reachableLane = findReachableLane(parentHash);
          if (reachableLane !== null) {
            parentLanes.push(reachableLane);
          } else {
            // Open a new lane for this merge parent. Prefer lane 0 if the parent
            // is on the primary chain and lane 0 is free.
            const wantPrimary = primaryChain.has(parentHash);
            const newLane = nextFreeLane(wantPrimary);
            occupied.add(newLane);
            reserveLane(newLane, parentHash);
            parentLanes.push(newLane);
            assignLaneColor(newLane, null, false);
          }
        }
      }
    }

    if (commit.parents.length === 0) {
      clearLane(lane);
    }

    const bottomLaneMap = compactLanes();
    const bottomParentLanes = parentLanes.map(parentLane => bottomLaneMap.get(parentLane) ?? parentLane);

    // ── Step 4: build graph lines with pre-computed colors ───────────────────
    const dotColor = currentLaneColor;
    const graphLines: GraphLine[] = [];

    graphLines.push({
      fromLane: lane,
      toLane: bottomParentLanes.length > 0 ? bottomParentLanes[0] : lane,
      type: 'straight',
      repoId: commit.repoId,
      isStart,
      color: dotColor,
    });

    for (let p = 1; p < bottomParentLanes.length; p++) {
      const pl = bottomParentLanes[p];
      graphLines.push({
        fromLane: lane,
        toLane: pl,
        type: 'merge-in',
        repoId: commit.repoId,
        color: laneColorOf.get(pl) ?? dotColor,
      });
    }

    for (const l of enteringLanes) {
      if (l === lane) continue;
      const bottomLane = bottomLaneMap.get(l);
      if (bottomLane === undefined) continue;
      graphLines.push({
        fromLane: l,
        toLane: bottomLane,
        type: 'pass-through',
        repoId: commit.repoId,
        color: laneColorOf.get(bottomLane) ?? anonymousLaneColor(bottomLane),
      });
    }

    const activeLaneCount = graphLines.reduce(
      (max, line) => Math.max(max, line.fromLane + 1, line.toLane + 1),
      lane + 1
    );

    laidOut.push({
      ...commit,
      lane,
      totalLanes: activeLaneCount,
      graphLines,
      dotColor,
    });
  }

  return laidOut;
}
