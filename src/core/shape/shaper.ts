import type { getFont } from "../../io/fonts/cache";
import type { BidiResult, GlyphInfo, GlyphPosition, ShapeFeature } from "text-shaper";
import {
  UnicodeBuffer,
  GlyphBuffer,
  shapeInto,
  getScript,
  getScriptTag,
  tag,
  Script,
  Direction,
  getEmbeddings,
  getMirror,
  getVisualOrder,
} from "text-shaper";

type FontHandle = Awaited<ReturnType<typeof getFont>>;

export type ShapeContext = {
  unicodeBuffer: UnicodeBuffer;
  runBuffer: GlyphBuffer;
  reorderInfos: GlyphInfo[];
  reorderPositions: GlyphPosition[];
};

const glyphBufferPool: GlyphBuffer[] = [];

export function acquireGlyphBuffer(capacity: number): GlyphBuffer {
  const buffer = glyphBufferPool.pop() ?? GlyphBuffer.withCapacity(capacity);
  buffer.reset();
  return buffer;
}

export function releaseGlyphBuffer(buffer: GlyphBuffer): void {
  buffer.reset();
  glyphBufferPool[glyphBufferPool.length] = buffer;
}

const ARABIC_FEATURES: ShapeFeature[] = [
  { tag: tag("init"), enabled: true },
  { tag: tag("medi"), enabled: true },
  { tag: tag("fina"), enabled: true },
  { tag: tag("isol"), enabled: true },
];

export function createShapeContext(): ShapeContext {
  return {
    unicodeBuffer: new UnicodeBuffer(),
    runBuffer: GlyphBuffer.withCapacity(64),
    reorderInfos: [],
    reorderPositions: [],
  };
}

function directionToString(dir: Direction): "ltr" | "rtl" {
  return dir === Direction.RTL ? "rtl" : "ltr";
}

function appendGlyphBuffer(dst: GlyphBuffer, src: GlyphBuffer): void {
  let outIdx = dst.infos.length;
  for (let i = 0; i < src.infos.length; i++) {
    const info = src.infos[i]!;
    const pos = src.positions[i]!;
    dst.infos[outIdx] = {
      glyphId: info.glyphId,
      cluster: info.cluster,
      mask: info.mask,
      codepoint: info.codepoint,
    };
    dst.positions[outIdx] = {
      xAdvance: pos.xAdvance,
      yAdvance: pos.yAdvance,
      xOffset: pos.xOffset,
      yOffset: pos.yOffset,
    };
    outIdx++;
  }
}

function buildCodeUnitMaps(text: string): {
  codeUnitToCodepoint: number[];
  codepointStarts: number[];
  codepointCount: number;
} {
  const codeUnitToCodepoint: number[] = new Array(text.length);
  const codepointStarts: number[] = [];
  let cpIndex = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    codeUnitToCodepoint[i] = cpIndex;
    codepointStarts[cpIndex] = i;
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codeUnitToCodepoint[i + 1] = cpIndex;
        i++;
      }
    }
    cpIndex++;
  }
  return {
    codeUnitToCodepoint,
    codepointStarts,
    codepointCount: cpIndex,
  };
}

type ScriptRun = {
  startCp: number;
  startCU: number;
  endCU: number;
  scriptTag: string;
  text: string;
};

function isAsciiLetterOrDigit(cp: number): boolean {
  return (
    (cp >= 0x30 && cp <= 0x39) ||
    (cp >= 0x41 && cp <= 0x5a) ||
    (cp >= 0x61 && cp <= 0x7a)
  );
}

function resolveScriptTag(cp: number, current: string | null): string {
  if (isAsciiLetterOrDigit(cp)) return "latn";
  const script = getScript(cp);
  if (script === Script.Common || script === Script.Inherited) {
    return current ?? "latn";
  }
  return getScriptTag(script);
}

function buildScriptRuns(text: string): ScriptRun[] {
  const runs: ScriptRun[] = [];
  if (text.length === 0) return runs;

  let runStartCU = 0;
  let runStartCp = 0;
  let runScriptTag: string | null = null;
  let cpIndex = 0;

  for (let cu = 0; cu < text.length; ) {
    const cp = text.codePointAt(cu) ?? 0;
    const cpLen = cp >= 0x10000 ? 2 : 1;
    const tag = resolveScriptTag(cp, runScriptTag);

    if (runScriptTag === null) {
      runScriptTag = tag;
      runStartCU = cu;
      runStartCp = cpIndex;
    } else if (tag !== runScriptTag) {
      runs[runs.length] = {
        startCp: runStartCp,
        startCU: runStartCU,
        endCU: cu,
        scriptTag: runScriptTag,
        text: text.slice(runStartCU, cu),
      };
      runScriptTag = tag;
      runStartCU = cu;
      runStartCp = cpIndex;
    }

    cu += cpLen;
    cpIndex++;
  }

  if (runScriptTag !== null) {
    runs[runs.length] = {
      startCp: runStartCp,
      startCU: runStartCU,
      endCU: text.length,
      scriptTag: runScriptTag,
      text: text.slice(runStartCU),
    };
  }

  return runs;
}

function reorderGlyphBufferForBidi(
  buffer: GlyphBuffer,
  text: string,
  ctx: ShapeContext,
  codeUnitToCodepoint: number[],
  codepointStarts: number[],
  codepointCount: number,
  bidi: BidiResult,
): void {
  if (buffer.infos.length === 0 || text.length === 0) return;

  const levelsByCluster = new Array<number>(codepointCount);
  for (let i = 0; i < codepointCount; i++) {
    const start = codepointStarts[i] ?? 0;
    levelsByCluster[i] = bidi.levels[start] ?? 0;
  }

  for (let i = 0; i < buffer.infos.length; i++) {
    const info = buffer.infos[i]!;
    const level = levelsByCluster[info.cluster] ?? 0;
    if (level & 1) {
      const mirrored = getMirror(info.codepoint);
      if (mirrored !== info.codepoint) info.codepoint = mirrored;
    }
  }

  const orderCU = getVisualOrder(text, bidi);
  if (orderCU.length === 0) return;

  const orderCP: number[] = [];
  const seenClusters = new Set<number>();
  for (let i = 0; i < orderCU.length; i++) {
    const cu = orderCU[i]!;
    const cp = codeUnitToCodepoint[cu] ?? 0;
    if (seenClusters.has(cp)) continue;
    seenClusters.add(cp);
    orderCP[orderCP.length] = cp;
  }

  const clusterToGlyphs = new Map<number, number[]>();
  for (let i = 0; i < buffer.infos.length; i++) {
    const cl = buffer.infos[i]!.cluster;
    let list = clusterToGlyphs.get(cl);
    if (!list) {
      list = [];
      clusterToGlyphs.set(cl, list);
    }
    list[list.length] = i;
  }

  const infos = ctx.reorderInfos;
  const positions = ctx.reorderPositions;
  let outIdx = 0;
  for (let i = 0; i < orderCP.length; i++) {
    const cp = orderCP[i]!;
    const list = clusterToGlyphs.get(cp);
    if (!list) continue;
    for (let j = 0; j < list.length; j++) {
      const gi = list[j]!;
      infos[outIdx] = buffer.infos[gi]!;
      positions[outIdx] = buffer.positions[gi]!;
      outIdx++;
    }
  }

  if (clusterToGlyphs.size > seenClusters.size) {
    for (let i = 0; i < buffer.infos.length; i++) {
      const info = buffer.infos[i]!;
      if (seenClusters.has(info.cluster)) continue;
      infos[outIdx] = info;
      positions[outIdx] = buffer.positions[i]!;
      outIdx++;
    }
  }

  buffer.infos.length = outIdx;
  buffer.positions.length = outIdx;
  for (let i = 0; i < outIdx; i++) {
    buffer.infos[i] = infos[i]!;
    buffer.positions[i] = positions[i]!;
  }
}

export function shapeTextWithRuns(
  font: FontHandle,
  text: string,
  baseDirection: Direction,
  ctx: ShapeContext,
  out: GlyphBuffer,
  features?: ShapeFeature[],
): void {
  out.reset();
  if (text.length === 0) return;

  const { codeUnitToCodepoint, codepointStarts, codepointCount } =
    buildCodeUnitMaps(text);

  const runs = buildScriptRuns(text);
  if (runs.length === 0) return;
  const bidi = getEmbeddings(text, baseDirection);

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    ctx.unicodeBuffer.clear();
    const runClusterStart = run.startCp;
    const runStartCU = run.startCU;
    const level = bidi.levels[runStartCU] ?? 0;
    const runDirection = level & 1 ? Direction.RTL : Direction.LTR;
    ctx.unicodeBuffer.addStr(run.text, runClusterStart);
    ctx.unicodeBuffer.setScript(run.scriptTag);
    ctx.unicodeBuffer.setDirection(runDirection);

    ctx.runBuffer.reset();
    const runFeatures =
      run.scriptTag === "arab"
        ? features && features.length > 0
          ? features.concat(ARABIC_FEATURES)
          : ARABIC_FEATURES
        : features;
    shapeInto(font, ctx.unicodeBuffer, ctx.runBuffer, {
      script: run.scriptTag,
      direction: directionToString(runDirection),
      features: runFeatures,
    });
    appendGlyphBuffer(out, ctx.runBuffer);
  }

  reorderGlyphBufferForBidi(
    out,
    text,
    ctx,
    codeUnitToCodepoint,
    codepointStarts,
    codepointCount,
    bidi,
  );
}
