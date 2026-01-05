import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { parseASS } from "subforge/ass";
import { renderFrameWithTrace } from "../src/core/pipeline";

const ASS_PATH = "test/fixtures/ass/benchmark.ass";

test("fixture trace produces events and layers", async () => {
  const text = readFileSync(ASS_PATH, "utf8");
  const parsed = parseASS(text, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  const rendered = await renderFrameWithTrace(parsed.document, 30000, 1920, 1080);
  expect(rendered.trace.events.length).toBeGreaterThan(0);

  const first = rendered.trace.events[0]!;
  expect(first.layerCount).toBeGreaterThan(0);
  expect(first.layers.length).toBe(first.layerCount);
  expect(first.lines.length).toBeGreaterThan(0);
  expect(first.margins.l).toBeGreaterThanOrEqual(0);
  expect(first.margins.r).toBeGreaterThanOrEqual(0);
  expect(first.margins.v).toBeGreaterThanOrEqual(0);
  expect(first.availableWidth).toBeGreaterThan(0);
  expect(first.blockAnchor.x).toBeGreaterThanOrEqual(0);
  expect(first.blockAnchor.y).toBeGreaterThanOrEqual(0);

  const line = first.lines[0]!;
  expect(Number.isFinite(line.x)).toBe(true);
  expect(line.height).toBeGreaterThan(0);

  const layer = first.layers[0]!;
  expect(Number.isFinite(layer.outlineX)).toBe(true);
  expect(Number.isFinite(layer.outlineY)).toBe(true);
  expect(Number.isFinite(layer.shadowX)).toBe(true);
  expect(Number.isFinite(layer.shadowY)).toBe(true);
  expect(Number.isFinite(layer.scaleXFactor)).toBe(true);
  expect(Number.isFinite(layer.scaleYFactor)).toBe(true);
});
