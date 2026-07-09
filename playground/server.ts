// Playground dev server: the same dev-bundler pipeline as
// `bun playground/index.html`, plus an explicit /worker-entry.js route so the
// prewarm worker pool can boot in the browser (Bun's dev bundler does not emit
// a worker chunk for `new Worker(new URL(...))`). app.ts probes this route and
// calls setWorkerSource("/worker-entry.js") when it responds.
// @ts-ignore Bun html import
import page from "./index.html";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const workerBuild = await Bun.build({
  entrypoints: [join(HERE, "../src/core/worker-entry.ts")],
  target: "browser",
  format: "esm",
  minify: false,
});
if (!workerBuild.success) {
  for (const log of workerBuild.logs) console.error(log);
  throw new Error("playground: worker-entry bundle failed");
}
const workerJs = await workerBuild.outputs[0]!.text();

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  development: true,
  routes: { "/": page },
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/worker-entry.js") {
      return new Response(workerJs, {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`playground: http://localhost:${server.port}/`);
