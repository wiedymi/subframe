declare module "subforge/ass" {
  import type { SubtitleDocument, TextSegment } from "subforge/core";

  export type ASSParseOptions = {
    onError?: "skip" | "collect";
    strict?: boolean;
    encoding?: "utf-8" | "utf-16le" | "utf-16be" | "shift-jis" | "auto";
    preserveOrder?: boolean;
  };

  export type ASSParseResult = {
    ok: boolean;
    document: SubtitleDocument;
    errors: Array<{ line: number; column: number; code: string; message: string; raw?: string }>;
    warnings: Array<{ line: number; message: string }>;
  };

  export function parseASS(input: string | ArrayBuffer | Uint8Array, options?: ASSParseOptions): ASSParseResult;
  export function parseTags(raw: string): TextSegment[];
}
