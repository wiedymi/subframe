import { existsSync } from "node:fs";
import { join } from "node:path";

type Manifest = {
  renderers: {
    libass: { cmd: string[] };
    subframe: { cmd: string[] };
  };
};

function getArg(args: string[], name: string, fallback?: string) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1];
}

function resolvePath(p: string): string {
  if (p.startsWith("/") || p.startsWith(".")) return p;
  return join(process.cwd(), p);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const manifestPath = getArg(args, "--manifest", "test/manifest.json")!;
  if (!existsSync(manifestPath)) {
    console.error(`Manifest not found: ${manifestPath}`);
    process.exit(1);
  }

  const manifest = JSON.parse(await Bun.file(manifestPath).text()) as Manifest;
  const libassCmd = manifest.renderers?.libass?.cmd?.[0];
  const subframeCmd = manifest.renderers?.subframe?.cmd?.[0];
  let ok = true;

  if (!libassCmd) {
    console.error("manifest.renderers.libass.cmd missing");
    ok = false;
  } else {
    const libassPath = resolvePath(libassCmd);
    if (!existsSync(libassPath)) {
      console.error(`libass renderer missing: ${libassPath}`);
      console.error("Build steps: tools/ref/build_libass.sh then follow tools/ref/README.md");
      ok = false;
    }
  }

  if (!subframeCmd) {
    console.error("manifest.renderers.subframe.cmd missing");
    ok = false;
  }

  const libassRef = resolvePath("refs/libass");
  if (!existsSync(libassRef)) {
    console.error("refs/libass submodule missing. Run: git submodule update --init --recursive");
    ok = false;
  }

  if (ok) {
    console.log("Golden preflight OK.");
    process.exit(0);
  }
  process.exit(1);
}
