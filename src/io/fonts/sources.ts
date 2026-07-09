import { Font, NameId, getNameById } from "text-shaper";
import { registerFontSource, type FontSource } from "./cache";

export type SubframeFontInput = ArrayBuffer | Uint8Array | Blob | File | string;
export type RegisteredFontSource = "embedded" | "provided";

export type RegisteredFontInfo = {
  names: string[];
  bytes: ArrayBuffer;
  source: RegisteredFontSource;
  label?: string;
};

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

export async function fontInputToBytes(input: SubframeFontInput): Promise<ArrayBuffer> {
  if (typeof input === "string") {
    const res = await fetch(input);
    if (!res.ok) throw new Error(`font fetch failed: ${res.status} ${res.statusText}`);
    return await res.arrayBuffer();
  }
  if (input instanceof ArrayBuffer) return input;
  if (ArrayBuffer.isView(input)) return toArrayBuffer(input);
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    return await input.arrayBuffer();
  }
  throw new Error("unsupported font input");
}

function addName(out: string[], seen: Set<string>, value: string | null | undefined): void {
  const name = value?.trim();
  if (!name) return;
  const key = name.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out[out.length] = name;
}

export async function extractFontNames(bytes: ArrayBuffer): Promise<string[]> {
  const font = await Font.loadAsync(bytes);
  const table = font.name;
  const names: string[] = [];
  const seen = new Set<string>();
  if (table) {
    addName(names, seen, getNameById(table, NameId.FontFamily));
    addName(names, seen, getNameById(table, NameId.TypographicFamily));
    addName(names, seen, getNameById(table, NameId.FullName));
    addName(names, seen, getNameById(table, NameId.PostScriptName));
  }
  return names;
}

export async function registerFontBytesByOwnNames(
  bytes: ArrayBuffer,
  source: RegisteredFontSource,
  label?: string,
): Promise<RegisteredFontInfo> {
  const names = await extractFontNames(bytes);
  if (names.length === 0 && label) names[names.length] = label;
  for (let i = 0; i < names.length; i++) {
    registerFontSource(names[i]!, bytes as FontSource);
  }
  return { names, bytes, source, label };
}

function decodeAssChunk(input: string, offset: number, count: number, out: number[]): void {
  let value = 0;
  for (let i = 0; i < count; i++) {
    value |= ((input.charCodeAt(offset + i) - 33) & 63) << (6 * (3 - i));
  }
  out[out.length] = (value >> 16) & 0xff;
  if (count >= 3) out[out.length] = (value >> 8) & 0xff;
  if (count >= 4) out[out.length] = value & 0xff;
}

// Mirrors libass ass.c decode_font/decode_chars: chars are offset by 33,
// groups of 4 decode to 3 bytes, trailing 2 chars decode to 1 byte, trailing
// 3 chars decode to 2 bytes, and length % 4 == 1 is invalid.
export function decodeAssEmbeddedFont(data: string): Uint8Array {
  const size = data.length;
  if (size % 4 === 1) throw new Error("bad ASS embedded font data size");
  const out: number[] = [];
  const full = Math.floor(size / 4);
  let offset = 0;
  for (let i = 0; i < full; i++, offset += 4) {
    decodeAssChunk(data, offset, 4, out);
  }
  const rem = size % 4;
  if (rem === 2 || rem === 3) decodeAssChunk(data, offset, rem, out);
  return new Uint8Array(out);
}
