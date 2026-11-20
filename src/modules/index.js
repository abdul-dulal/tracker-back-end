import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Auto-discover module files so modules can be added without editing a central list:
 *   src/modules/<name>/routes*.js  → default export: createRouter() api or { router, prefix }
 *   src/modules/<name>/jobs.js     → registers background jobs / crons on import
 */
export async function loadModules() {
  const routers = [];
  const names = (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const name of names) {
    const files = (await fs.readdir(path.join(dir, name))).sort();
    for (const f of files) {
      const full = pathToFileURL(path.join(dir, name, f)).href;
      if (/^routes.*\.js$/.test(f)) {
        const mod = await import(full);
        const list = [].concat(mod.default ?? []);
        for (const r of list) if (r?.router && r.prefix !== undefined) routers.push({ module: name, ...r });
      } else if (f === 'jobs.js') {
        await import(full);
      }
    }
  }
  return routers;
}
