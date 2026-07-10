import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = join(root, "dist-pages");
rmSync(outdir, { recursive: true, force: true });

const worker = await Bun.build({
  entrypoints: [join(root, "src/core/worker-entry.ts")],
  outdir,
  target: "browser",
  format: "esm",
  minify: true,
});
if (!worker.success) {
  for (const log of worker.logs) console.error(log);
  throw new Error("playground worker bundle failed");
}
const workerOutput = worker.outputs.find((output) =>
  output.path.endsWith("worker-entry.js"),
);
if (!workerOutput) {
  throw new Error("playground build did not emit worker-entry.js");
}
const inlineWorkerCode = await workerOutput.text();

const page = await Bun.build({
  entrypoints: [join(root, "playground/index.html")],
  outdir,
  target: "browser",
  minify: true,
  plugins: [
    {
      name: "inline-subframe-worker",
      setup(build) {
        build.onLoad({ filter: /generated\/worker-inline\.ts$/ }, () => ({
          contents: `export const INLINED_WORKER_CODE = ${JSON.stringify(inlineWorkerCode)};`,
          loader: "ts",
        }));
      },
    },
  ],
});
if (!page.success) {
  for (const log of page.logs) console.error(log);
  throw new Error("playground page bundle failed");
}

console.log(
  `playground: ${page.outputs.length} page assets + inline worker + worker-entry.js`,
);
