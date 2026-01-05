import type { SubtitleEvent } from "subforge/core";
import type { MoveParams } from "../tags/types";

export function computeMovePosition(
  ev: SubtitleEvent,
  timeMs: number,
  move: MoveParams,
): { x: number; y: number } {
  const start = ev.start;
  const end = ev.end;
  const t1 = move.t1 ?? 0;
  const t2 = move.t2 ?? end - start;
  const startTime = start + t1;
  const endTime = start + t2;
  if (endTime <= startTime) return { x: move.to[0], y: move.to[1] };
  if (timeMs <= startTime) return { x: move.from[0], y: move.from[1] };
  if (timeMs >= endTime) return { x: move.to[0], y: move.to[1] };
  const t = (timeMs - startTime) / (endTime - startTime);
  return {
    x: move.from[0] + (move.to[0] - move.from[0]) * t,
    y: move.from[1] + (move.to[1] - move.from[1]) * t,
  };
}
