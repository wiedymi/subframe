import { afterEach, expect, test } from "bun:test";
import { parseASS } from "subforge/ass";
import { Subframe } from "../src";
import {
  clearRegisteredFontSourcesForTests,
  resetFontCache,
  snapshotFontSources,
} from "../src/io/fonts/cache";
import { resetLocalFontAccessForTests } from "../src/io/fonts/local-access";
import {
  decodeAssEmbeddedFont,
  extractFontNames,
} from "../src/io/fonts/sources";

const ARIAL_PATH = "test/fixtures/jassub-benchmark/fonts/arial.ttf";
const LATO_PATH = "test/fixtures/jassub-benchmark/fonts/Lato-Regular.ttf";

afterEach(() => {
  clearRegisteredFontSourcesForTests();
  resetLocalFontAccessForTests();
});

function assForFont(fontName: string): string {
  return `[Script Info]
Title: subframe-api
ScriptType: v4.00+
PlayResX: 320
PlayResY: 180

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,Hello
`;
}

function basicDocument(fontName = "Arial") {
  const parsed = parseASS(assForFont(fontName), {
    onError: "collect",
    strict: false,
    preserveOrder: true,
  });
  if (!parsed.ok) throw new Error("parse failed");
  return parsed.document;
}

async function readFont(path: string): Promise<ArrayBuffer> {
  return await Bun.file(path).arrayBuffer();
}

function encodeAssEmbeddedFont(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const value = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += String.fromCharCode(((value >> 18) & 63) + 33);
    out += String.fromCharCode(((value >> 12) & 63) + 33);
    out += String.fromCharCode(((value >> 6) & 63) + 33);
    out += String.fromCharCode((value & 63) + 33);
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const value = bytes[i]! << 16;
    out += String.fromCharCode(((value >> 18) & 63) + 33);
    out += String.fromCharCode(((value >> 12) & 63) + 33);
  } else if (rem === 2) {
    const value = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += String.fromCharCode(((value >> 18) & 63) + 33);
    out += String.fromCharCode(((value >> 12) & 63) + 33);
    out += String.fromCharCode(((value >> 6) & 63) + 33);
  }
  return out;
}

test("Subframe lifecycle renders and releases a headless frame", async () => {
  const sf = new Subframe({ workers: false });
  try {
    await sf.ready;
    sf.resize(320, 180);
    sf.setDocument(basicDocument());
    const frame = await sf.frame(1000);
    expect(frame.layers.length).toBeGreaterThan(0);
    expect(frame.frame.width).toBe(320);
    expect(frame.frame.height).toBe(180);
    frame.release();
    frame.release();
    expect(sf.stats().hasDocument).toBe(true);
  } finally {
    sf.dispose();
  }
});

test("Subframe warms the requested initial media time", async () => {
  const sf = new Subframe({ workers: false });
  try {
    await sf.ready;
    sf.resize(320, 180);
    await sf.setDocument(basicDocument(), { timeMs: 1234, playbackFps: 24 });
    expect(sf.stats().attach?.timeMs).toBe(1234);
  } finally {
    sf.dispose();
  }
});

test("Subframe registers provided font buffers under extracted names", async () => {
  const bytes = await readFont(LATO_PATH);
  const names = await extractFontNames(bytes);
  expect(names).toContain("Lato-Regular");
  const sf = new Subframe({ workers: false, fonts: [bytes] });
  try {
    await sf.ready;
    sf.resize(320, 180);
    sf.setDocument(basicDocument("Lato-Regular"));
    const frame = await sf.frame(1000);
    expect(frame.layers.length).toBeGreaterThan(0);
    frame.release();
    const stats = sf.stats().fonts;
    expect(stats.providedFonts).toBe(1);
    expect(stats.provided).toBeGreaterThan(0);
  } finally {
    sf.dispose();
  }
});

test("Subframe accepts URL font entries", async () => {
  const bytes = await readFont(LATO_PATH);
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(bytes, {
        headers: { "content-type": "font/ttf" },
      });
    },
  });
  const sf = new Subframe({
    workers: false,
    fonts: [`${server.url}Lato-Regular.ttf`],
  });
  try {
    await sf.ready;
    sf.resize(320, 180);
    sf.setDocument(basicDocument("Lato"));
    const frame = await sf.frame(1000);
    expect(frame.layers.length).toBeGreaterThan(0);
    frame.release();
    expect(sf.stats().fonts.providedFonts).toBe(1);
  } finally {
    sf.dispose();
    server.stop(true);
  }
});

test("Subframe decodes and registers embedded ASS fonts", async () => {
  const bytes = new Uint8Array(await readFont(ARIAL_PATH));
  const encoded = encodeAssEmbeddedFont(bytes);
  const decoded = decodeAssEmbeddedFont(encoded);
  expect(decoded.byteLength).toBe(bytes.byteLength);
  expect(Buffer.compare(Buffer.from(decoded), Buffer.from(bytes))).toBe(0);
  const sf = new Subframe({ workers: false });
  try {
    await sf.ready;
    sf.resize(320, 180);
    const doc = basicDocument("ArialMT") as ReturnType<typeof basicDocument> & {
      fonts?: Array<{ name: string; data: string }>;
    };
    doc.fonts = [{ name: "arial.ttf", data: encoded }];
    sf.setDocument(doc);
    const frame = await sf.frame(1000);
    expect(frame.layers.length).toBeGreaterThan(0);
    frame.release();
    const stats = sf.stats().fonts;
    expect(stats.embeddedFonts).toBe(1);
    expect(stats.embedded).toBeGreaterThan(0);
  } finally {
    sf.dispose();
  }
});

test("Subframe font resolution prefers provided fonts over Local Font Access", async () => {
  resetLocalFontAccessForTests();
  resetFontCache();
  const localBytes = await readFont(ARIAL_PATH);
  const providedBytes = await readFont(LATO_PATH);
  const previousQuery = (
    globalThis as typeof globalThis & {
      queryLocalFonts?: () => Promise<unknown[]>;
    }
  ).queryLocalFonts;
  (
    globalThis as typeof globalThis & {
      queryLocalFonts?: () => Promise<unknown[]>;
    }
  ).queryLocalFonts = async () => [
    {
      family: "Lato",
      fullName: "Lato Regular",
      postscriptName: "Lato-Regular",
      style: "Regular",
      blob: async () => new Blob([localBytes]),
    },
  ];
  const sf = new Subframe({ workers: false, fonts: [providedBytes] });
  try {
    await sf.ready;
    sf.resize(320, 180);
    sf.setDocument(basicDocument("Lato"));
    const frame = await sf.frame(1000);
    expect(frame.layers.length).toBeGreaterThan(0);
    frame.release();
    const stats = sf.stats().fonts;
    expect(stats.provided).toBeGreaterThan(0);
    expect(stats.local).toBe(0);
  } finally {
    sf.dispose();
    if (previousQuery) {
      (
        globalThis as typeof globalThis & {
          queryLocalFonts?: () => Promise<unknown[]>;
        }
      ).queryLocalFonts = previousQuery;
    } else {
      delete (
        globalThis as typeof globalThis & {
          queryLocalFonts?: () => Promise<unknown[]>;
        }
      ).queryLocalFonts;
    }
    resetLocalFontAccessForTests();
  }
});

test("Subframe keeps instance-owned font aliases out of the global registry", async () => {
  const bytes = await readFont(LATO_PATH);
  const sf = new Subframe({ workers: false, fonts: [bytes] });
  await sf.ready;
  expect(sf.stats().fonts.providedFonts).toBe(1);
  expect(snapshotFontSources()).toHaveLength(0);
  sf.dispose();
  expect(snapshotFontSources()).toHaveLength(0);
});

test("switching to a document without embedded fonts removes old aliases", async () => {
  const bytes = new Uint8Array(await readFont(ARIAL_PATH));
  const sf = new Subframe({ workers: false });
  try {
    await sf.ready;
    sf.resize(320, 180);
    const embeddedDoc = basicDocument("ArialMT") as ReturnType<
      typeof basicDocument
    > & {
      fonts?: Array<{ name: string; data: string }>;
    };
    embeddedDoc.fonts = [
      { name: "arial.ttf", data: encodeAssEmbeddedFont(bytes) },
    ];
    sf.setDocument(embeddedDoc);
    (await sf.frame(1000)).release();
    expect(sf.stats().fonts.embeddedFonts).toBe(1);
    expect(snapshotFontSources()).toHaveLength(0);

    sf.setDocument(basicDocument("Arial"));
    (await sf.frame(1000)).release();
    expect(sf.stats().fonts.embeddedFonts).toBe(0);
    expect(snapshotFontSources()).toHaveLength(0);
  } finally {
    sf.dispose();
  }
});

test("Subframe instances render independently and survive peer disposal", async () => {
  const first = new Subframe({ workers: false });
  const second = new Subframe({ workers: false });
  try {
    await Promise.all([first.ready, second.ready]);
    first.resize(320, 180);
    second.resize(640, 360);
    await Promise.all([
      first.setDocument(basicDocument("Arial")),
      second.setDocument(basicDocument("Lato")),
    ]);
    const [firstFrame, secondFrame] = await Promise.all([
      first.frame(1000),
      second.frame(1000),
    ]);
    expect(firstFrame.frame.width).toBe(320);
    expect(secondFrame.frame.width).toBe(640);
    expect(firstFrame.layers.length).toBeGreaterThan(0);
    expect(secondFrame.layers.length).toBeGreaterThan(0);
    firstFrame.release();
    secondFrame.release();

    first.dispose();
    const survivingFrame = await second.frame(1000);
    expect(survivingFrame.frame.width).toBe(640);
    expect(survivingFrame.layers.length).toBeGreaterThan(0);
    survivingFrame.release();
  } finally {
    first.dispose();
    second.dispose();
  }
});

test("Subframe font registries isolate the same alias across instances", async () => {
  const [arial, lato] = await Promise.all([
    readFont(ARIAL_PATH),
    readFont(LATO_PATH),
  ]);
  const first = new Subframe({ workers: false, fonts: { Shared: arial } });
  const second = new Subframe({ workers: false, fonts: { Shared: lato } });
  try {
    await Promise.all([first.ready, second.ready]);
    first.resize(320, 180);
    second.resize(320, 180);
    await Promise.all([
      first.setDocument(basicDocument("Shared")),
      second.setDocument(basicDocument("Shared")),
    ]);
    const [firstFrame, secondFrame] = await Promise.all([
      first.frame(1000),
      second.frame(1000),
    ]);
    const checksum = (frame: typeof firstFrame): number => {
      let hash = 0x811c9dc5;
      for (let l = 0; l < frame.layers.length; l++) {
        const bytes = frame.layers[l]!.bitmap;
        for (let i = 0; i < bytes.length; i++) {
          hash = Math.imul(hash ^ bytes[i]!, 0x01000193) >>> 0;
        }
      }
      return hash;
    };
    expect(checksum(firstFrame)).not.toBe(checksum(secondFrame));
    firstFrame.release();
    secondFrame.release();
  } finally {
    first.dispose();
    second.dispose();
  }
});

test("worker-enabled Subframe instances own independent pools and font registries", async () => {
  const [arial, lato] = await Promise.all([
    readFont(ARIAL_PATH),
    readFont(LATO_PATH),
  ]);
  const first = new Subframe({
    workerCount: 1,
    fonts: { Shared: arial },
  });
  const second = new Subframe({
    workerCount: 1,
    fonts: { Shared: lato },
  });
  const checksum = (frame: Awaited<ReturnType<Subframe["frame"]>>): number => {
    let hash = 0x811c9dc5;
    for (let l = 0; l < frame.layers.length; l++) {
      const bytes = frame.layers[l]!.bitmap;
      for (let i = 0; i < bytes.length; i++) {
        hash = Math.imul(hash ^ bytes[i]!, 0x01000193) >>> 0;
      }
    }
    return hash;
  };
  try {
    await Promise.all([first.ready, second.ready]);
    first.resize(320, 180);
    second.resize(320, 180);
    await Promise.all([
      first.setDocument(basicDocument("Shared"), { timeMs: 1000 }),
      second.setDocument(basicDocument("Shared"), { timeMs: 1000 }),
    ]);
    const [firstFrame, secondFrame] = await Promise.all([
      first.frame(1000),
      second.frame(1000),
    ]);
    expect(checksum(firstFrame)).not.toBe(checksum(secondFrame));
    expect(first.stats().workerPool.workers).toBe(1);
    expect(second.stats().workerPool.workers).toBe(1);
    firstFrame.release();
    secondFrame.release();

    first.dispose();
    expect(second.stats().workerPool.active).toBe(true);
    const survivingFrame = await second.frame(1000 + 1000 / 60);
    expect(survivingFrame.layers.length).toBeGreaterThan(0);
    survivingFrame.release();
  } finally {
    first.dispose();
    second.dispose();
  }
});

test("instance worker output matches the direct renderer", async () => {
  const lato = await readFont(LATO_PATH);
  const direct = new Subframe({ workers: false, fonts: { Shared: lato } });
  const threaded = new Subframe({
    workerCount: 1,
    fonts: { Shared: lato },
  });
  try {
    await Promise.all([direct.ready, threaded.ready]);
    direct.resize(320, 180);
    threaded.resize(320, 180);
    await Promise.all([
      direct.setDocument(basicDocument("Shared"), { timeMs: 1000 }),
      threaded.setDocument(basicDocument("Shared"), { timeMs: 1000 }),
    ]);
    const [expected, actual] = await Promise.all([
      direct.frame(1000),
      threaded.frame(1000),
    ]);
    expect(actual.layers).toHaveLength(expected.layers.length);
    for (let i = 0; i < expected.layers.length; i++) {
      const a = actual.layers[i]!;
      const e = expected.layers[i]!;
      expect({
        width: a.width,
        height: a.height,
        originX: a.originX,
        originY: a.originY,
        color: a.color,
        z: a.z,
      }).toEqual({
        width: e.width,
        height: e.height,
        originX: e.originX,
        originY: e.originY,
        color: e.color,
        z: e.z,
      });
      expect(Buffer.from(a.bitmap)).toEqual(Buffer.from(e.bitmap));
    }
    expected.release();
    actual.release();
  } finally {
    direct.dispose();
    threaded.dispose();
  }
});

test("instance worker dedup retains static frame arenas until every consumer releases", async () => {
  const lato = await readFont(LATO_PATH);
  const sf = new Subframe({ workerCount: 1, fonts: { Shared: lato } });
  try {
    await sf.ready;
    sf.resize(320, 180);
    await sf.setDocument(basicDocument("Shared"), { timeMs: 1000 });

    const first = await sf.frame(1000);
    const expected = Buffer.from(first.layers[0]!.bitmap);
    first.release();

    const held = await sf.frame(1000 + 1000 / 60);
    const next = await sf.frame(1000 + (2 * 1000) / 60);
    expect(held.layers[0]!.bitmap).toBe(next.layers[0]!.bitmap);
    next.release();
    expect(Buffer.from(held.layers[0]!.bitmap)).toEqual(expected);
    expect(sf.stats().pipeline.dedupHits).toBeGreaterThanOrEqual(2);
    held.release();
  } finally {
    sf.dispose();
  }
});

test("Subframe headless frame works under Bun with default workers", async () => {
  const sf = new Subframe();
  try {
    await sf.ready;
    sf.resize(320, 180);
    sf.setDocument(basicDocument());
    const frame = await sf.frame(1000);
    expect(frame.layers.length).toBeGreaterThan(0);
    frame.release();
  } finally {
    sf.dispose();
  }
});
