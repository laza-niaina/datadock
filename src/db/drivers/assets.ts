/**
 * Directory that holds runtime assets which cannot be bundled into
 * `dist/extension.js` (currently only `sql-wasm.wasm`).
 *
 * IMPORTANT: nothing under `src/db` may import `vscode`, and this module keeps
 * that promise - `__dirname` is a plain Node.js free variable. esbuild leaves it
 * untouched for `format: 'cjs'`, so inside the shipped bundle it is
 * `<extension>/dist`, which is exactly where `esbuild.js` copies
 * `sql-wasm.wasm` to.
 */

/**
 * Directory holding non-bundleable runtime assets.
 * Evaluated by Node at runtime, so it tracks the bundle location.
 */
export const DEFAULT_ASSETS_DIR: string = __dirname;

/**
 * Returns a usable asset directory; blank or undefined input falls back to the
 * bundle directory, so hand-built `DriverDeps` (unit tests, drivers) never crash.
 */
export function resolveAssetsDir(assetsDir?: string): string {
  if (typeof assetsDir === 'string' && assetsDir.trim() !== '') {
    return assetsDir.trim();
  }
  return DEFAULT_ASSETS_DIR;
}