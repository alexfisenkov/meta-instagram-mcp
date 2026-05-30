import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const srcDir = join(root, "src");
const outDir = join(root, "dist");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: findTypeScriptFiles(srcDir),
  outbase: srcDir,
  outdir: outDir,
  bundle: false,
  format: "esm",
  platform: "node",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
});

function findTypeScriptFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return findTypeScriptFiles(path);
    if (entry.isFile() && entry.name.endsWith(".ts")) return [relative(root, path)];
    return [];
  });
}
