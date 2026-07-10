import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });

const worker = await Bun.build({
  entrypoints: [join(root, "src/core/worker-entry.ts")],
  target: "browser",
  format: "esm",
  minify: true,
});
if (!worker.success || !worker.outputs[0]) {
  for (const log of worker.logs) console.error(log);
  throw new Error("worker-entry inline bundle failed");
}
const inlineWorkerCode = await worker.outputs[0].text();

const main = await Bun.build({
  entrypoints: [join(root, "src/index.ts")],
  outdir: dist,
  target: "browser",
  format: "esm",
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
if (!main.success) {
  for (const log of main.logs) console.error(log);
  throw new Error("subframe browser bundle failed");
}

const standaloneWorker = await Bun.build({
  entrypoints: [join(root, "src/core/worker-entry.ts")],
  outdir: dist,
  target: "browser",
  format: "esm",
});
if (!standaloneWorker.success) {
  for (const log of standaloneWorker.logs) console.error(log);
  throw new Error("subframe standalone worker bundle failed");
}

console.log(`inline worker: ${(inlineWorkerCode.length / 1024).toFixed(1)} KiB`);
