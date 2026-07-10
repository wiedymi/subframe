import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { diffPng } from "../tools/diff/pngdiff";

async function writePixel(
  path: string,
  rgba: [number, number, number, number],
): Promise<void> {
  const png = new PNG({ width: 1, height: 1 });
  png.data.set(rgba);
  await Bun.write(path, PNG.sync.write(png));
}

test("PNG diff ignores RGB hidden by zero alpha", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subframe-pngdiff-"));
  const a = join(dir, "a.png");
  const b = join(dir, "b.png");
  const out = join(dir, "diff.png");
  const stats = join(dir, "diff.json");
  await Promise.all([
    writePixel(a, [255, 20, 10, 0]),
    writePixel(b, [0, 0, 0, 0]),
  ]);
  expect(diffPng(a, b, out, stats).maxError).toBe(0);
  expect(JSON.parse(readFileSync(stats, "utf8")).space).toBe("premultiplied-rgba");
});

test("PNG diff measures visible premultiplied edge coverage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subframe-pngdiff-"));
  const a = join(dir, "a.png");
  const b = join(dir, "b.png");
  await Promise.all([
    writePixel(a, [255, 255, 255, 1]),
    writePixel(b, [0, 0, 0, 0]),
  ]);
  const result = diffPng(a, b, join(dir, "diff.png"), join(dir, "diff.json"));
  expect(result.maxError).toBe(1);
});
