import type { CommitNode, GraphCommitNode, GraphLine } from '../../shared/types';
import { anonymousLaneColor, groupRefs, type RefGroup } from './refs';
import {
  branchPaletteIndex,
  currentPalette,
  headColor,
  primaryBranchColor,
  tagColor,
} from '../../shared/branchColors';
import { isPrimaryBranch } from '../../shared/branchUtils';
import { scopedKey } from '../../shared/scopedKey';

export const LANE_WIDTH = 20;
export const ROW_HEIGHT = 28;
export const DOT_RADIUS = 5;

// JetBrains hides the middle of edges whose endpoints are at least 30 rows
// apart. The row next to each endpoint remains visible and carries an arrow.
export const LONG_EDGE_MIN_ROWS = 30;

export interface GraphLayoutData {
  lane: number;
  totalLanes: number;
  graphLines: GraphLine[];
  dotColor: string;
}

export type LaidOutCommit = CommitNode & GraphLayoutData;
export type LaidOutGraphCommit = GraphCommitNode & GraphLayoutData;

interface LaneColor {
  color: string;
  paletteIndex: number;
}

interface LayoutRef {
  group: RefGroup;
  priority: number;
  name: string;
}

interface LayoutEdge {
  id: number;
  repoId: string;
  up: number;
  down: number | null;
  collapsed: boolean;
  color?: string;
}

type LayoutElement =
  | { kind: 'node'; row: number }
  | { kind: 'edge'; edge: LayoutEdge };

function primaryRef(
  refs: string[],
  vcsKind: 'git' | 'svn',
  remoteNames: readonly string[],
): RefGroup | null {
  const groups = groupRefs(refs, vcsKind, remoteNames);
  return groups.find(group => group.isHead && group.isLocal)
    ?? groups.find(group => group.isLocal && !group.isTag)
    ?? groups.find(group => group.isRemote && !group.isRemoteHead)
    ?? groups.find(group => group.isTag)
    ?? groups.find(group => group.isHead)
    ?? null;
}

function commitKey(commit: Pick<GraphCommitNode, 'repoId' | 'hash'>): string {
  return scopedKey(commit.repoId, commit.hash);
}

function parentKey(commit: Pick<GraphCommitNode, 'repoId'>, parentHash: string): string {
  return scopedKey(commit.repoId, parentHash);
}

function paletteDistance(left: number, right: number, size: number): number {
  const distance = Math.abs(left - right);
  return Math.min(distance, size - distance);
}

function pickPaletteIndex(preferred: number, usedIndices: Set<number>): number {
  const paletteSize = currentPalette().length;
  if (usedIndices.size === 0) return preferred;

  let bestIndex = preferred;
  let bestMinimumDistance = -1;
  for (let index = 0; index < paletteSize; index++) {
    let minimumDistance = paletteSize;
    for (const usedIndex of usedIndices) {
      minimumDistance = Math.min(
        minimumDistance,
        paletteDistance(index, usedIndex, paletteSize),
      );
    }

    if (
      minimumDistance > bestMinimumDistance
      || (
        minimumDistance === bestMinimumDistance
        && paletteDistance(index, preferred, paletteSize)
          < paletteDistance(bestIndex, preferred, paletteSize)
      )
    ) {
      bestMinimumDistance = minimumDistance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function layoutRefPriority(group: RefGroup): number {
  if (
    group.isRemote
    && !group.isRemoteHead
    && group.remoteName === 'origin'
    && isPrimaryBranch(group.label)
  ) {
    return 0;
  }
  if (group.isRemote && !group.isRemoteHead) return 1;
  if (group.isLocal && isPrimaryBranch(group.label)) return 2;
  if (group.isLocal && !group.isTag) return 3;
  if (group.isTag) return 4;
  if (group.isHead) return 6;
  return 7;
}

function bestLayoutRef(
  commit: GraphCommitNode,
  repoKindById: Readonly<Record<string, 'git' | 'svn'>>,
  remoteNamesByRepo: Readonly<Record<string, readonly string[]>>,
): LayoutRef | null {
  const vcsKind = repoKindById[commit.repoId] ?? 'git';
  const groups = groupRefs(
    commit.refs,
    vcsKind,
    remoteNamesByRepo[commit.repoId] ?? [],
  );
  let best: LayoutRef | null = null;
  for (const group of groups) {
    const candidate = {
      group,
      priority: layoutRefPriority(group),
      name: group.isRemote && group.remoteName
        ? `${group.remoteName}/${group.label}`
        : group.label,
    };
    if (
      best === null
      || candidate.priority < best.priority
      || (
        candidate.priority === best.priority
        && candidate.name.localeCompare(best.name, undefined, { numeric: true }) < 0
      )
    ) {
      best = candidate;
    }
  }
  return best;
}

function compareEdgeToNode(
  edge: LayoutEdge,
  nodeRow: number,
  layoutIndex: readonly number[],
): number {
  if (edge.down === null) {
    return layoutIndex[edge.up] - layoutIndex[nodeRow];
  }
  const edgeLayoutIndex = Math.max(
    layoutIndex[edge.up],
    layoutIndex[edge.down],
  );
  const nodeLayoutIndex = layoutIndex[nodeRow];
  return edgeLayoutIndex !== nodeLayoutIndex
    ? edgeLayoutIndex - nodeLayoutIndex
    : edge.up - nodeRow;
}

// Row-local ordering adapts JetBrains' Apache-2.0 GraphLayoutBuilder and
// GraphElementComparatorByLayoutIndex model to the Webview's SVG segments.
function compareEdges(
  left: LayoutEdge,
  right: LayoutEdge,
  layoutIndex: readonly number[],
): number {
  if (left.down === null) {
    return -compareEdgeToNode(right, left.up, layoutIndex);
  }
  if (right.down === null) {
    return compareEdgeToNode(left, right.up, layoutIndex);
  }

  if (left.up === right.up) {
    return left.down < right.down
      ? -compareEdgeToNode(right, left.down, layoutIndex)
      : compareEdgeToNode(left, right.down, layoutIndex);
  }
  return left.up < right.up
    ? compareEdgeToNode(left, right.up, layoutIndex)
    : -compareEdgeToNode(right, left.up, layoutIndex);
}

function compareElements(
  left: LayoutElement,
  right: LayoutElement,
  layoutIndex: readonly number[],
): number {
  if (left.kind === 'edge' && right.kind === 'edge') {
    return compareEdges(left.edge, right.edge, layoutIndex);
  }
  if (left.kind === 'edge' && right.kind === 'node') {
    return compareEdgeToNode(left.edge, right.row, layoutIndex);
  }
  if (left.kind === 'node' && right.kind === 'edge') {
    return -compareEdgeToNode(right.edge, left.row, layoutIndex);
  }
  return left.kind === 'node' && right.kind === 'node'
    ? left.row - right.row
    : 0;
}

export function assignLanes<T extends GraphCommitNode>(
  commits: readonly T[],
  isFiltered = false,
  repoKindById: Readonly<Record<string, 'git' | 'svn'>> = {},
  remoteNamesByRepo: Readonly<Record<string, readonly string[]>> = {},
): Array<T & GraphLayoutData> {
  if (commits.length === 0) return [];

  const rowByKey = new Map<string, number>();
  commits.forEach((commit, row) => rowByKey.set(commitKey(commit), row));

  const parentsByRow = Array.from(
    { length: commits.length },
    (): number[] => [],
  );
  const childCountByRow = Array.from({ length: commits.length }, () => 0);
  const edges: LayoutEdge[] = [];
  let nextEdgeId = 1;

  for (let row = 0; row < commits.length; row++) {
    const commit = commits[row];
    for (const parentHash of commit.parents) {
      const targetRow = rowByKey.get(parentKey(commit, parentHash)) ?? null;
      if (targetRow === null && isFiltered) continue;
      if (targetRow !== null && targetRow <= row) continue;

      if (targetRow !== null) {
        parentsByRow[row].push(targetRow);
        childCountByRow[targetRow]++;
      }
      edges.push({
        id: nextEdgeId++,
        repoId: commit.repoId,
        up: row,
        down: targetRow,
        collapsed: targetRow === null
          || targetRow - row >= LONG_EDGE_MIN_ROWS,
      });
    }
  }

  const layoutRefs = commits.map(commit => bestLayoutRef(
    commit,
    repoKindById,
    remoteNamesByRepo,
  ));
  const branchHeadRows = new Set<number>();
  for (let row = 0; row < commits.length; row++) {
    const ref = layoutRefs[row]?.group;
    if (
      ref
      && !ref.isTag
      && !ref.isRemoteHead
      && (ref.isLocal || ref.isRemote)
    ) {
      branchHeadRows.add(row);
    }
    if (childCountByRow[row] === 0) branchHeadRows.add(row);
  }

  const sortedHeads = Array.from(branchHeadRows).sort((leftRow, rightRow) => {
    const leftRef = layoutRefs[leftRow];
    const rightRef = layoutRefs[rightRow];
    if (leftRef === null && rightRef === null) return leftRow - rightRow;
    if (leftRef === null) return 1;
    if (rightRef === null) return -1;
    if (leftRef.priority !== rightRef.priority) {
      return leftRef.priority - rightRef.priority;
    }
    const nameOrder = leftRef.name.localeCompare(
      rightRef.name,
      undefined,
      { numeric: true },
    );
    if (nameOrder !== 0) return nameOrder;
    const rootOrder = commits[leftRow].repoId.localeCompare(commits[rightRow].repoId);
    return rootOrder !== 0 ? rootOrder : leftRow - rightRow;
  });

  const layoutIndex = Array.from({ length: commits.length }, () => 0);
  const owningHead = Array.from({ length: commits.length }, () => -1);
  const importantHeads: number[] = [];
  let currentLayoutIndex = 1;

  for (const headRow of sortedHeads) {
    if (layoutIndex[headRow] !== 0) continue;
    importantHeads.push(headRow);
    const stack = [headRow];

    while (stack.length > 0) {
      const currentRow = stack[stack.length - 1];
      const firstVisit = layoutIndex[currentRow] === 0;
      if (firstVisit) {
        layoutIndex[currentRow] = currentLayoutIndex;
        owningHead[currentRow] = headRow;
      }

      const nextParent = parentsByRow[currentRow].find(
        parentRow => layoutIndex[parentRow] === 0,
      );
      if (nextParent !== undefined) {
        stack.push(nextParent);
      } else {
        if (firstVisit) currentLayoutIndex++;
        stack.pop();
      }
    }
  }

  // Natural heads cover every disconnected component, but retain a defensive
  // fallback for malformed or partially filtered input.
  for (let row = 0; row < commits.length; row++) {
    if (layoutIndex[row] !== 0) continue;
    layoutIndex[row] = currentLayoutIndex++;
    owningHead[row] = row;
    importantHeads.push(row);
  }

  const palette = currentPalette();
  const usedPaletteIndices = new Set<number>();
  const colorByHead = new Map<number, LaneColor>();
  for (const headRow of importantHeads) {
    const commit = commits[headRow];
    const vcsKind = repoKindById[commit.repoId] ?? 'git';
    const ref = primaryRef(
      commit.refs,
      vcsKind,
      remoteNamesByRepo[commit.repoId] ?? [],
    );
    const isHeadCommit = commit.refs.some(rawRef => (
      rawRef.startsWith('HEAD -> ') || rawRef === 'HEAD'
    ));
    const isBranch = ref !== null
      && (ref.isLocal || ref.isRemote)
      && !ref.isTag
      && !ref.isRemoteHead;

    let laneColor: LaneColor;
    if (isBranch && isPrimaryBranch(ref.label)) {
      laneColor = { color: primaryBranchColor(), paletteIndex: -1 };
    } else if (isHeadCommit) {
      laneColor = { color: headColor(), paletteIndex: -2 };
    } else if (ref?.isTag) {
      laneColor = { color: tagColor(), paletteIndex: -3 };
    } else {
      const preferred = ref === null
        ? (layoutIndex[headRow] - 1) % palette.length
        : branchPaletteIndex(ref.label);
      const paletteIndex = pickPaletteIndex(preferred, usedPaletteIndices);
      usedPaletteIndices.add(paletteIndex);
      laneColor = { color: palette[paletteIndex], paletteIndex };
    }
    colorByHead.set(headRow, laneColor);
  }

  const nodeColor = (row: number): string => {
    const headRow = owningHead[row] >= 0 ? owningHead[row] : row;
    if (layoutIndex[row] === layoutIndex[headRow]) {
      return colorByHead.get(headRow)?.color ?? anonymousLaneColor(layoutIndex[row]);
    }
    return palette[(layoutIndex[row] - 1) % palette.length];
  };
  for (const edge of edges) {
    const colorRow = edge.down !== null
      && layoutIndex[edge.down] > layoutIndex[edge.up]
      ? edge.down
      : edge.up;
    edge.color = nodeColor(colorRow);
  }

  const crossingEdgesByRow = Array.from(
    { length: commits.length },
    (): LayoutEdge[] => [],
  );
  for (const edge of edges) {
    if (edge.down === null) {
      if (edge.up + 1 < commits.length) {
        crossingEdgesByRow[edge.up + 1].push(edge);
      }
      continue;
    }

    const distance = edge.down - edge.up;
    if (distance <= 1) continue;
    if (edge.collapsed) {
      crossingEdgesByRow[edge.up + 1].push(edge);
      crossingEdgesByRow[edge.down - 1].push(edge);
    } else {
      for (let row = edge.up + 1; row < edge.down; row++) {
        crossingEdgesByRow[row].push(edge);
      }
    }
  }

  const nodeLaneByRow = Array.from({ length: commits.length }, () => 0);
  const edgeLaneByRow = Array.from(
    { length: commits.length },
    (): Map<number, number> => new Map(),
  );
  const elementCountByRow = Array.from({ length: commits.length }, () => 1);

  for (let row = 0; row < commits.length; row++) {
    const elements: LayoutElement[] = [
      { kind: 'node', row },
      ...crossingEdgesByRow[row].map(edge => ({ kind: 'edge' as const, edge })),
    ];
    elements.sort((left, right) => compareElements(left, right, layoutIndex));
    elementCountByRow[row] = elements.length;
    elements.forEach((element, lane) => {
      if (element.kind === 'node') nodeLaneByRow[row] = lane;
      else edgeLaneByRow[row].set(element.edge.id, lane);
    });
  }

  const graphLinesByRow = Array.from(
    { length: commits.length },
    (): GraphLine[] => [],
  );

  const positionAt = (edge: LayoutEdge, row: number): number | null => {
    if (row < 0 || row >= commits.length) return null;
    if (row === edge.up || row === edge.down) return nodeLaneByRow[row];
    return edgeLaneByRow[row].get(edge.id) ?? null;
  };

  const connectAdjacentRows = (
    edge: LayoutEdge,
    upperRow: number,
    lowerRow: number,
  ): void => {
    const upperLane = positionAt(edge, upperRow);
    const lowerLane = positionAt(edge, lowerRow);
    if (upperLane === null || lowerLane === null) return;
    const boundaryLane = (upperLane + lowerLane) / 2;
    graphLinesByRow[upperRow].push({
      fromLane: upperLane,
      toLane: boundaryLane,
      type: 'fork-out',
      repoId: edge.repoId,
      color: edge.color,
    });
    graphLinesByRow[lowerRow].push({
      fromLane: boundaryLane,
      toLane: lowerLane,
      type: 'join-in',
      repoId: edge.repoId,
      color: edge.color,
    });
  };

  for (const edge of edges) {
    if (edge.down === null) {
      if (edge.up + 1 >= commits.length) continue;
      connectAdjacentRows(edge, edge.up, edge.up + 1);
      const terminalLane = positionAt(edge, edge.up + 1);
      if (terminalLane !== null) {
        graphLinesByRow[edge.up + 1].push({
          fromLane: terminalLane,
          toLane: terminalLane,
          type: 'collapsed-out',
          repoId: edge.repoId,
          color: edge.color,
        });
      }
      continue;
    }

    if (!edge.collapsed) {
      for (let row = edge.up; row < edge.down; row++) {
        connectAdjacentRows(edge, row, row + 1);
      }
      continue;
    }

    connectAdjacentRows(edge, edge.up, edge.up + 1);
    const headLane = positionAt(edge, edge.up + 1);
    if (headLane !== null) {
      graphLinesByRow[edge.up + 1].push({
        fromLane: headLane,
        toLane: headLane,
        type: 'collapsed-out',
        repoId: edge.repoId,
        color: edge.color,
      });
    }

    const tailLane = positionAt(edge, edge.down - 1);
    if (tailLane !== null) {
      graphLinesByRow[edge.down - 1].push({
        fromLane: tailLane,
        toLane: tailLane,
        type: 'collapsed-in',
        repoId: edge.repoId,
        color: edge.color,
      });
    }
    connectAdjacentRows(edge, edge.down - 1, edge.down);
  }

  return commits.map((commit, row): T & GraphLayoutData => {
    const graphLines = graphLinesByRow[row];
    const totalLanes = Math.max(
      elementCountByRow[row],
      ...graphLines.flatMap(line => [
        Math.ceil(line.fromLane + 1),
        Math.ceil(line.toLane + 1),
      ]),
    );
    return {
      ...commit,
      lane: nodeLaneByRow[row],
      totalLanes,
      graphLines,
      dotColor: nodeColor(row),
    };
  });
}
