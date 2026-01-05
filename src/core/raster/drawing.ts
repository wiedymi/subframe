import { computeTightBounds } from "text-shaper";

export function quantizePath(
  path: { commands: Array<any>; bounds: any; flags?: number },
  step: number,
): { commands: Array<any>; bounds: any; flags?: number } {
  const inv = step !== 0 ? 1 / step : 0;
  const q = (v: number) => (inv ? Math.round(v * inv) / inv : v);
  const cmds = path.commands;
  const out: Array<any> = new Array(cmds.length);
  for (let i = 0; i < cmds.length; i++) {
    const cmd = cmds[i]!;
    switch (cmd.type) {
      case "M":
      case "L":
        out[i] = { type: cmd.type, x: q(cmd.x), y: q(cmd.y) };
        break;
      case "Q":
        out[i] = {
          type: "Q",
          x1: q(cmd.x1),
          y1: q(cmd.y1),
          x: q(cmd.x),
          y: q(cmd.y),
        };
        break;
      case "C":
        out[i] = {
          type: "C",
          x1: q(cmd.x1),
          y1: q(cmd.y1),
          x2: q(cmd.x2),
          y2: q(cmd.y2),
          x: q(cmd.x),
          y: q(cmd.y),
        };
        break;
      default:
        out[i] = cmd;
        break;
    }
  }
  const outPath = { commands: out, bounds: null as any, flags: path.flags };
  if (out.length > 0) {
    const bounds = computeTightBounds(outPath as any);
    if (
      Number.isFinite(bounds.xMin) &&
      Number.isFinite(bounds.yMin) &&
      Number.isFinite(bounds.xMax) &&
      Number.isFinite(bounds.yMax)
    ) {
      outPath.bounds = bounds;
    }
  }
  return outPath;
}
