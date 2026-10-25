// Bundles ui/main.ts + ui/style.css into public/ and copies index.html.
import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public");
await mkdir(out, { recursive: true });
await build({
  entryPoints: { app: join(here, "main.ts") },
  bundle: true,
  minify: true,
  sourcemap: true,
  format: "iife",
  target: "es2022",
  outdir: out,
  loader: { ".css": "css" },
  logLevel: "info",
});
await build({
  entryPoints: { app: join(here, "style.css") },
  bundle: true,
  minify: true,
  outdir: out,
  logLevel: "info",
});
await copyFile(join(here, "index.html"), join(out, "index.html"));
