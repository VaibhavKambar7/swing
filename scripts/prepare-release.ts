import { cp, mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
async function main() {
  try {
    const root = process.cwd();
    const standalone = resolve(root, ".next/standalone");
    await stat(resolve(standalone, "server.js"));
    await mkdir(resolve(standalone, ".next"), { recursive: true });
    await cp(resolve(root, ".next/static"), resolve(standalone, ".next/static"), { recursive: true, force: true });
    const publicDir = resolve(root, "public");
    try { await stat(publicDir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; console.log(JSON.stringify({ event: "standalone_assets_prepared", publicAssets: false })); return; }
    await cp(publicDir, resolve(standalone, "public"), { recursive: true, force: true });
    console.log(JSON.stringify({ event: "standalone_assets_prepared", publicAssets: true }));
  } catch {
    console.error(JSON.stringify({ event: "standalone_assets_failed", code: "BUILD_OUTPUT_REQUIRED" }));
    process.exitCode = 1;
  }
}
void main();
