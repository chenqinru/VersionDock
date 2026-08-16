import React from 'react';
import type { LaidOutCommit } from '../utils/graphLayout';
import { DOT_RADIUS, LANE_WIDTH, ROW_HEIGHT } from '../utils/graphLayout';
import { anonymousLaneColor } from '../utils/refs';

function laneX(lane: number): number {
  return lane * LANE_WIDTH + LANE_WIDTH / 2;
}

const STROKE_WIDTH = 1.5;
const ARROW_STROKE_WIDTH = 2;
const ARROW_SIZE = ROW_HEIGHT * 0.32;
const HALF_ROW = ROW_HEIGHT / 2;
const DOWN_ARROW_Y = ROW_HEIGHT * 0.78;
const UP_ARROW_Y = ROW_HEIGHT * 0.22;

interface RowSvgProps {
  commit: LaidOutCommit;
  isSelected: boolean;
}

export const CommitRowSvg = React.memo(function CommitRowSvg({
  commit,
  isSelected,
}: RowSvgProps) {
  const lines = commit.graphLines ?? [];
  const dotLane = commit.lane ?? 0;
  const dotColor = commit.dotColor ?? anonymousLaneColor(dotLane);
  const activeLanes = lines.reduce(
    (maximum, line) => Math.max(
      maximum,
      line.fromLane + 1,
      line.toLane + 1,
    ),
    dotLane + 1,
  );
  const svgWidth = activeLanes * LANE_WIDTH + 4;
  const dotX = laneX(dotLane);
  const radius = isSelected ? DOT_RADIUS + 1 : DOT_RADIUS;
  const haloRadius = radius + 1.5;

  return (
    <svg
      width={svgWidth}
      height={ROW_HEIGHT}
      style={{ display: 'block', flexShrink: 0, overflow: 'visible' }}
    >
      {lines.map((line, index) => {
        const color = line.color ?? anonymousLaneColor(line.fromLane);
        const fromX = laneX(line.fromLane);
        const toX = laneX(line.toLane);
        const common = {
          stroke: color,
          strokeWidth: STROKE_WIDTH,
          strokeLinecap: 'round' as const,
          strokeLinejoin: 'round' as const,
        };

        if (line.type === 'join-in') {
          return (
            <line
              key={index}
              x1={fromX}
              y1={0}
              x2={toX}
              y2={HALF_ROW}
              {...common}
            />
          );
        }

        if (line.type === 'fork-out') {
          return (
            <line
              key={index}
              x1={fromX}
              y1={HALF_ROW}
              x2={toX}
              y2={ROW_HEIGHT}
              {...common}
            />
          );
        }

        if (line.type === 'pass-through') {
          return (
            <line
              key={index}
              x1={fromX}
              y1={0}
              x2={toX}
              y2={ROW_HEIGHT}
              {...common}
            />
          );
        }

        if (line.type === 'collapsed-out') {
          return (
            <React.Fragment key={index}>
              <line
                x1={fromX}
                y1={HALF_ROW}
                x2={toX}
                y2={DOWN_ARROW_Y}
                {...common}
              />
              <ArrowHead
                startX={fromX}
                startY={HALF_ROW}
                tipX={toX}
                tipY={DOWN_ARROW_Y}
                color={color}
              />
            </React.Fragment>
          );
        }

        return (
          <React.Fragment key={index}>
            <line
              x1={fromX}
              y1={UP_ARROW_Y}
              x2={toX}
              y2={HALF_ROW}
              {...common}
            />
            <ArrowHead
              startX={toX}
              startY={HALF_ROW}
              tipX={fromX}
              tipY={UP_ARROW_Y}
              color={color}
            />
          </React.Fragment>
        );
      })}

      <circle
        cx={dotX}
        cy={HALF_ROW}
        r={haloRadius}
        fill="var(--vscode-editor-background)"
      />
      {isSelected ? (
        <>
          <circle
            cx={dotX}
            cy={HALF_ROW}
            r={radius}
            fill="var(--vscode-editor-background)"
            stroke={dotColor}
            strokeWidth={2}
          />
          <circle cx={dotX} cy={HALF_ROW} r={2} fill={dotColor} />
        </>
      ) : (
        <circle
          cx={dotX}
          cy={HALF_ROW}
          r={radius}
          fill={dotColor}
          stroke="var(--vscode-editor-background)"
          strokeWidth={1}
        />
      )}
    </svg>
  );
});

function ArrowHead({
  startX,
  startY,
  tipX,
  tipY,
  color,
}: {
  startX: number;
  startY: number;
  tipX: number;
  tipY: number;
  color: string;
}) {
  const deltaX = tipX - startX;
  const deltaY = tipY - startY;
  const length = Math.hypot(deltaX, deltaY) || 1;
  const directionX = deltaX / length;
  const directionY = deltaY / length;
  const perpendicularX = -directionY;
  const perpendicularY = directionX;
  const back = ARROW_SIZE * 0.84;
  const side = ARROW_SIZE * 0.55;
  const leftX = tipX - directionX * back + perpendicularX * side;
  const leftY = tipY - directionY * back + perpendicularY * side;
  const rightX = tipX - directionX * back - perpendicularX * side;
  const rightY = tipY - directionY * back - perpendicularY * side;

  return (
    <path
      d={`M ${leftX} ${leftY} L ${tipX} ${tipY} L ${rightX} ${rightY}`}
      fill="none"
      stroke={color}
      strokeWidth={ARROW_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}
