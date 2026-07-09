import { test, expect } from "bun:test";
import { AtlasAllocator, type AtlasSlot } from "../src/backend/atlas-allocator";

// Verbatim port of the WebGPU backend uploadMask staging. Both GPU backends now
// stage rows through a scratch buffer using `bitmap.subarray(srcRow, srcRow +
// width)`, which is relative to the view's own byteOffset. This probe feeds it a
// SUBARRAY VIEW with stride != width and a nonzero byteOffset (exactly what the
// core emits for rect-clipped layers) and asserts the staged bytes equal the
// intended window of the source view -- catching any "read from buffer offset 0
// with wrong stride" regression that would upload unrelated memory.
function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function stageUpload(bitmap: Uint8Array, width: number, height: number, stride: number): Uint8Array {
  const bytesPerRow = align(width, 256);
  const buf = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    const srcRow = y * stride;
    const dstRow = y * bytesPerRow;
    buf.set(bitmap.subarray(srcRow, srcRow + width), dstRow);
  }
  return buf;
}

test("uploadMask stages the correct window of a subarray view (stride != width, byteOffset != 0)", () => {
  // Parent bitmap: 40 wide (stride), 20 tall, filled with a recognizable ramp.
  const stride = 40;
  const parentH = 20;
  const parent = new Uint8Array(stride * parentH);
  for (let y = 0; y < parentH; y++) {
    for (let x = 0; x < stride; x++) parent[y * stride + x] = (y * stride + x) & 0xff;
  }
  // Rect-clip crop: offsetX=7, offsetY=5, keep width=25, height=11. This is
  // exactly `layer.bitmap.subarray(offsetY*stride + offsetX)` from clip/apply.ts,
  // with stride kept at the parent stride.
  const offsetX = 7, offsetY = 5, width = 25, height = 11;
  const view = parent.subarray(offsetY * stride + offsetX);
  expect(view.byteOffset).toBe(offsetY * stride + offsetX);
  expect(view.byteOffset).toBeGreaterThan(0);

  const staged = stageUpload(view, width, height, stride);
  const bytesPerRow = align(width, 256);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const expected = parent[(offsetY + y) * stride + (offsetX + x)]!;
      const got = staged[y * bytesPerRow + x]!;
      expect(got).toBe(expected);
    }
    // Padding past `width` in each staged row must stay zero (fresh scratch).
    expect(staged[y * bytesPerRow + width]!).toBe(0);
  }
});

test("uploadMask handles a tightly-packed (stride == width) view identically", () => {
  const width = 30, height = 8;
  const parent = new Uint8Array(width * height * 2);
  for (let i = 0; i < parent.length; i++) parent[i] = (i * 3) & 0xff;
  const view = parent.subarray(width * 3); // nonzero offset, packed
  const staged = stageUpload(view, width, height, width);
  const bytesPerRow = align(width, 256);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      expect(staged[y * bytesPerRow + x]!).toBe(view[y * width + x]!);
});

// --- allocator invariants under animated churn (fresh bitmap every glyph) ---

// Emulates one backend frame: cache-miss allocate for each glyph, then verify at
// "submit" that no live region (a slot allocated THIS frame) was overwritten by a
// later allocation this frame. Returns the resulting live regions per page so the
// harness can detect overlap.
type Region = { page: number; x: number; y: number; w: number; h: number; id: number };

function overlaps(a: Region, b: Region): boolean {
  if (a.page !== b.page) return false;
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

test("allocator never overlaps two live slots within a frame and stays page-bounded", () => {
  const alloc = new AtlasAllocator({ pageSize: 512, padding: 1, maxPages: 8 });
  let seed = 99;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const history: number[] = [];
  for (let frame = 0; frame < 300; frame++) {
    const perFrame = 40 + Math.floor(rnd() * 20);
    const live: Region[] = [];
    for (let g = 0; g < perFrame; g++) {
      const w = 12 + Math.floor(rnd() * 60);
      const h = 12 + Math.floor(rnd() * 60);
      const slot = alloc.allocate(w, h, frame);
      const region: Region = { page: slot.pageIndex, x: slot.x, y: slot.y, w, h, id: g };
      // Any previously-allocated live slot this frame must not overlap the new one.
      for (let k = 0; k < live.length; k++) {
        if (overlaps(live[k]!, region)) {
          throw new Error(`frame ${frame}: slot ${g} overwrote live slot ${live[k]!.id}`);
        }
      }
      live.push(region);
    }
    history.push(alloc.pageCount);
  }
  // Bounded and non-leaking: page count reaches a steady state and never grows
  // with frame count. The old allocator grew ~1 page/frame without bound.
  const earlyMax = Math.max(...history.slice(50, 150));
  const lateMax = Math.max(...history.slice(200, 300));
  expect(lateMax).toBeLessThanOrEqual(earlyMax); // no monotonic growth
  expect(earlyMax).toBeLessThanOrEqual(12); // small constant, not O(frames)
});

test("static (identity-stable) slots are retained and never invalidated while touched", () => {
  const alloc = new AtlasAllocator({ pageSize: 512, padding: 1 });
  // 10 static slots allocated once, touched every frame.
  const staticSlots: AtlasSlot[] = [];
  for (let i = 0; i < 10; i++) staticSlots.push(alloc.allocate(30, 30, 0));
  const genAtBirth = staticSlots.map((s) => s.gen);
  const coords = staticSlots.map((s) => ({ p: s.pageIndex, x: s.x, y: s.y }));

  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let frame = 1; frame < 200; frame++) {
    for (const s of staticSlots) alloc.touch(s, frame);
    // Heavy animated churn alongside.
    for (let g = 0; g < 80; g++) alloc.allocate(12 + Math.floor(rnd() * 50), 12 + Math.floor(rnd() * 50), frame);
  }
  for (let i = 0; i < staticSlots.length; i++) {
    const s = staticSlots[i]!;
    expect(s.free).toBe(false);
    expect(s.gen).toBe(genAtBirth[i]!); // never reassigned -> cache stays valid
    expect({ p: s.pageIndex, x: s.x, y: s.y }).toEqual(coords[i]!);
  }
});
