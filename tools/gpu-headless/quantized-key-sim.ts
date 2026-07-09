import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PathBuilder } from "text-shaper";
import { parseASS } from "subforge/ass";
import type { SubtitleDocument, SubtitleEvent } from "subforge/core";
import { setFontSearchPaths } from "../../src/io/fonts/resolve";
import { buildEventLayout } from "../../src/core/layout/event";
import type { LineItem } from "../../src/core/layout/line";
import { createShapeContext } from "../../src/core/shape/shaper";
import { frameContextFromDocument, frameEventParams } from "../../src/core/frame";
import { quantSubpixel } from "../../src/core/math/fixed";
import { quantizeTransformPos } from "../../src/core/filters/blur";
import { splitSubpixel } from "../../src/core/raster/bitmap";
import { itemRotateOrShear } from "../../src/core/transform/affine";
import {
  buildTransformMatrix,
  quantizeTransform,
  type PathCbox,
} from "../../src/core/transform/matrix";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const FIXTURES = join(ROOT, "test/fixtures/jassub-benchmark");
const W = 1920;
const H = 1080;

const WINDOW_START = 246350;
const WINDOW_END = 251350;

setFontSearchPaths([join(FIXTURES, "fonts")]);

type RecordKey = {
  eventIndex: number;
  contentKey: string;
  exactKey: string;
  quantKey: string;
};

function matrixKey(m: number[][]): string {
  return `${m[0]![0]},${m[0]![1]},${m[0]![2]},${m[1]![0]},${m[1]![1]},${m[1]![2]},${m[2]![0]},${m[2]![1]},${m[2]![2]}`;
}

function quantizedKey(
  matrix: number[][],
  cbox: PathCbox,
  padX: number,
  padY: number,
  delta: { x: number; y: number } | null,
): { key: string; residualX: number; residualY: number } | null {
  const q = quantizeTransform(matrix, cbox, delta, padX, padY);
  if (!q) return null;
  const qq = q.q;
  return {
    key: `phase=${qq.offsetX},${qq.offsetY}|qm=${qq.qm.join(",")}`,
    residualX: q.residualX,
    residualY: q.residualY,
  };
}

function lineStartX(layout: Awaited<ReturnType<typeof buildEventLayout>>, lineWidth: number, frameWidth: number): number {
  if (!layout) return 0;
  const hAlign = layout.align % 3;
  let xStart = layout.marginL;
  if (layout.posX === null) {
    if (hAlign === 2) {
      xStart = layout.marginL + (frameWidth - layout.marginL - layout.marginR - lineWidth) / 2;
    } else if (hAlign === 0) {
      xStart = frameWidth - layout.marginR - lineWidth;
    }
  } else {
    if (hAlign === 2) xStart = layout.posX - lineWidth / 2;
    else if (hAlign === 0) xStart = layout.posX - lineWidth;
    else xStart = layout.posX;
  }
  return quantSubpixel(xStart);
}

function eventSampleTime(ev: SubtitleEvent): number {
  const start = Math.max(ev.start, WINDOW_START);
  const end = Math.min(ev.end, WINDOW_END);
  return Math.max(WINDOW_START, Math.min(WINDOW_END, (start + end) / 2));
}

function eventOverlapsWindow(ev: SubtitleEvent): boolean {
  return ev.start < WINDOW_END && ev.end > WINDOW_START;
}

function textStyleKey(ev: SubtitleEvent, item: LineItem): string {
  return [
    ev.style,
    item.baseStyle.name ?? "",
    item.fontSize,
    item.scaleXFactor,
    item.scaleYFactor,
    item.rotateZ,
    item.rotateX,
    item.rotateY,
    item.shearX,
    item.shearY,
    item.borderX,
    item.borderY,
    item.blur,
    item.edgeBlur,
  ].join("|");
}

async function main() {
  const text = readFileSync(join(FIXTURES, "subtitles", "beastars.ass"), "utf8");
  const parsed = parseASS(text, { onError: "collect", strict: false, preserveOrder: true });
  const doc: SubtitleDocument = parsed.document;
  const shapeCtx = createShapeContext();
  const usedGlyphBuffers = [];
  const drawingRecords: RecordKey[] = [];
  const textRecords: RecordKey[] = [];
  const drawingEvents = new Set<number>();
  const textEvents = new Set<number>();

  for (let eventIndex = 0; eventIndex < doc.events.length; eventIndex++) {
    const ev = doc.events[eventIndex]!;
    if (!eventOverlapsWindow(ev)) continue;

    const timeMs = eventSampleTime(ev);
    const frame = frameContextFromDocument(doc, timeMs, W, H);
    const params = frameEventParams(doc, frame);
    const layout = await buildEventLayout({
      doc,
      ev,
      frame,
      timeMs,
      ...params,
      shapeCtx,
      usedGlyphBuffers,
    });
    if (!layout) continue;

    let penY = layout.topY;
    let qtRunSegment = -1;
    let qtRunDelta: { x: number; y: number } | null = null;
    for (let li = 0; li < layout.lines.length; li++) {
      const line = layout.lines[li]!;
      const xStart = lineStartX(layout, line.width, frame.width);
      const baselineY = quantSubpixel(penY + line.ascent);
      let penX = xStart;

      for (let ii = 0; ii < line.items.length; ii++) {
        const item = line.items[ii]!;
        const shearXAdj =
          item.shearX !== 0 && item.scaleX !== 0 && item.scaleY !== 0
            ? item.shearX * (item.scaleX / item.scaleY)
            : item.shearX;
        const shearYAdj =
          item.shearY !== 0 && item.scaleX !== 0 && item.scaleY !== 0
            ? item.shearY * (item.scaleY / item.scaleX)
            : item.shearY;
        const originX = item.originOverride ? quantSubpixel(item.originOverride.x) : layout.blockAnchorX;
        const originY = item.originOverride ? quantSubpixel(item.originOverride.y) : layout.blockAnchorY;
        const useTransform = itemRotateOrShear(
          item.rotateZ,
          item.rotateX,
          item.rotateY,
          item.shearX,
          item.shearY,
        );

        if (item.drawingPath) {
          const drawScaleX = item.scaleXFactor * layout.safeScreenScaleXPar;
          const drawScaleY = item.scaleYFactor * layout.safeScreenScaleY;
          const gx = useTransform ? penX : quantizeTransformPos(penX);
          const gy = useTransform ? baselineY : quantizeTransformPos(baselineY);
          let exactPlacement = `pos=${gx},${gy}|scale=${drawScaleX},${drawScaleY}|baseline=${item.drawingBaseline}`;
          let quantPlacement = exactPlacement;

          if (useTransform) {
            const matrix = buildTransformMatrix(
              gx,
              gy,
              originX,
              originY,
              item.rotateZ,
              item.rotateX,
              item.rotateY,
              shearXAdj,
              shearYAdj,
              item.ascent,
              params.parScaleX,
              layout.safeBlurScaleY,
            );
            exactPlacement = matrixKey(matrix);

            let builder = PathBuilder.fromPath(item.drawingPath).scale(drawScaleX, drawScaleY);
            if (item.drawingBaseline !== 0) builder = builder.translate(0, -item.drawingBaseline);
            const cb = builder.controlBox();
            if (cb && Number.isFinite(cb.xMin) && Number.isFinite(cb.yMin) && cb.xMin <= cb.xMax && cb.yMin <= cb.yMax) {
              if (item.segmentIndex !== qtRunSegment) {
                qtRunSegment = item.segmentIndex;
                qtRunDelta = null;
              }
              const q = quantizedKey(
                matrix,
                { minX: cb.xMin, minY: cb.yMin, maxX: cb.xMax, maxY: cb.yMax },
                drawScaleX,
                drawScaleY,
                qtRunDelta,
              );
              if (q) {
                if (!qtRunDelta) qtRunDelta = { x: q.residualX, y: q.residualY };
                quantPlacement = q.key;
              }
            }
          } else {
            const sx = splitSubpixel(gx).s;
            const sy = splitSubpixel(gy).s;
            quantPlacement = `scale=${drawScaleX},${drawScaleY}|phase=${sx},${sy}|baseline=${item.drawingBaseline}`;
          }

          drawingRecords.push({
            eventIndex,
            contentKey: item.text,
            exactKey: `${item.text}|${exactPlacement}`,
            quantKey: `${item.text}|${quantPlacement}`,
          });
          drawingEvents.add(eventIndex);
        } else if (!item.isWhitespace && item.text.length > 0) {
          const styleKey = textStyleKey(ev, item);
          let gx = useTransform ? penX : quantizeTransformPos(penX);
          let gy = useTransform ? baselineY : quantizeTransformPos(baselineY);
          let exactPlacement = `pos=${gx},${gy}`;
          let quantPlacement = `phase=${splitSubpixel(gx).s},${splitSubpixel(gy).s}`;
          if (useTransform) {
            const matrix = buildTransformMatrix(
              gx,
              gy,
              originX,
              originY,
              item.rotateZ,
              item.rotateX,
              item.rotateY,
              shearXAdj,
              shearYAdj,
              item.ascent,
              params.parScaleX,
              layout.safeBlurScaleY,
            );
            exactPlacement = matrixKey(matrix);
            const cbox = {
              minX: 0,
              minY: -item.ascent,
              maxX: Math.max(item.width, 1),
              maxY: Math.max(item.descent, 1),
            };
            const padX = (item.fontSize * item.scaleXFactor) / 256;
            const padY = (item.fontSize * item.scaleYFactor) / 256;
            if (item.segmentIndex !== qtRunSegment) {
              qtRunSegment = item.segmentIndex;
              qtRunDelta = null;
            }
            const q = quantizedKey(matrix, cbox, padX, padY, qtRunDelta);
            if (q) {
              if (!qtRunDelta) qtRunDelta = { x: q.residualX, y: q.residualY };
              quantPlacement = q.key;
            }
          }
          textRecords.push({
            eventIndex,
            contentKey: `${styleKey}|${item.text}`,
            exactKey: `${styleKey}|${item.text}|${exactPlacement}`,
            quantKey: `${styleKey}|${item.text}|${quantPlacement}`,
          });
          textEvents.add(eventIndex);
        }

        penX = quantSubpixel(penX + item.width + item.spacingAfter);
      }

      penY = quantSubpixel(penY + line.height);
    }
  }

  function report(label: string, records: RecordKey[], events: Set<number>) {
    const exact = new Set(records.map((r) => r.exactKey));
    const quant = new Set(records.map((r) => r.quantKey));
    const contentCounts = new Map<string, number>();
    for (const r of records) contentCounts.set(r.contentKey, (contentCounts.get(r.contentKey) ?? 0) + 1);
    let maxContentRepeat = 0;
    for (const count of contentCounts.values()) {
      if (count > maxContentRepeat) maxContentRepeat = count;
    }
    const reuse = quant.size > 0 ? records.length / quant.size : 0;
    console.log(
      `${label}: sourceEvents=${events.size} records=${records.length} distinctContent=${contentCounts.size} maxContentRepeat=${maxContentRepeat} distinctExact=${exact.size} distinctQuantized=${quant.size} reuseFactor=${reuse.toFixed(2)}`,
    );
  }

  console.log(`=== quantized key simulation beastars window=${WINDOW_START}..${WINDOW_END} ===`);
  console.log("drawing: mirrors PathBuilder cbox + buildTransformMatrix + quantizeTransform for transformed drawing items");
  console.log("text: approximate item-level text matrix; real transformed glyph cache quantizes per glyph fill/stroke cbox");
  report("drawing", drawingRecords, drawingEvents);
  report("text", textRecords, textEvents);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
