import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const snapshot = join(dist, "subforge-core.d.ts");
const upstreamTypes = join(root, "node_modules/subforge/src/core/types.ts");

writeFileSync(
  snapshot,
  "// Generated from the pinned subforge dependency. Runtime values remain Subforge objects.\n" +
    readFileSync(upstreamTypes, "utf8"),
);

function declarationFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...declarationFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

for (const file of declarationFiles(dist)) {
  if (file === snapshot) continue;
  let specifier = relative(dirname(file), snapshot.slice(0, -5)).split(sep).join("/");
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  const source = readFileSync(file, "utf8");
  const rewritten = source.replaceAll('from "subforge/core"', `from "${specifier}"`);
  if (rewritten !== source) writeFileSync(file, rewritten);
}
