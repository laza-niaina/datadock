// Build script for the extension bundle.
//
// Strategy: everything except the `vscode` module is bundled into a single
// CommonJS file (dist/extension.js). Runtime assets that cannot be bundled
// (for example WASM binaries) are copied explicitly into dist/ by
// copyRuntimeAssets() so that .vscodeignore can exclude node_modules entirely.

const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Files that must exist on disk at runtime, relative to the project root.
 * `{ from, to }` pairs, `to` being relative to the project root too.
 * A `required` asset aborts the build when its source is missing, so a
 * forgotten `npm install` can never produce a silently broken bundle.
 */
const RUNTIME_ASSETS = [
  { from: 'node_modules/sql.js/dist/sql-wasm.wasm', to: 'dist/sql-wasm.wasm', required: true },
];

function copyRuntimeAssets() {
  for (const asset of RUNTIME_ASSETS) {
    if (!fs.existsSync(asset.from)) {
      if (asset.required) {
        throw new Error(
          `Required runtime asset '${asset.from}' is missing. Run 'npm install' before building.`,
        );
      }
      continue;
    }
    fs.mkdirSync(path.dirname(asset.to), { recursive: true });
    fs.copyFileSync(asset.from, asset.to);
    console.log(`[assets] ${asset.from} -> ${asset.to}`);
  }
}

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: production ? false : 'inline',
  minify: production,
  keepNames: true,
  logLevel: 'info',
  metafile: production,
  external: [
    'vscode',
    // Optional native accelerators pulled in by ssh2's crypto bindings.
    // They are loaded inside try/catch upstream; keeping them external avoids
    // esbuild resolution errors on platforms where they are not installable.
    'cpu-features',
    './crypto/build/Release/sshcrypto.node',
    // Optional native connectors for pg (libpq bindings, cloudflare socket)
    // and mssql (Windows integrated auth). None are used by this build: pg
    // always uses pure-JS sockets and mssql only SQL authentication. External
    // so esbuild does not try to resolve them on any platform.
    'pg-native',
    'pg-cloudflare',
    'msnodesqlv8',
  ],
};

/**
 * Webview bundle for the result view (query results + table viewer) compiled
 * by the second esbuild entry into `dist/webview/resultApp.js`. Built as a
 * standalone IIFE over the shared page shell (renderDataGridPage): Vue 2
 * runtime + umy-table, no template compiler, so the strict CSP never needs
 * unsafe-eval. The loader keeps stray webfont assets (vendored element-icons)
 * as real files; `font-src 'none'` in the page CSP keeps them inert.
 */
/** @type {import('esbuild').BuildOptions} */
const webviewOptions = {
  entryPoints: ['src/ui/resultView/resultApp.ts'],
  outfile: 'dist/webview/resultApp.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: production ? false : 'inline',
  minify: production,
  keepNames: true,
  logLevel: 'info',
  metafile: production,
  loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
};

/**
 * Stylesheet of the connection form, compiled by a third esbuild entry into
 * `dist/webview/formApp.css` and served through `asWebviewUri`. It imports
 * `ui/shared/tokens.css`, the same token file the result view imports, so the
 * two webviews cannot drift apart. A CSS entry point keeps the form's markup in
 * TypeScript and its design in CSS instead of a 200-line inline string.
 */
/** @type {import('esbuild').BuildOptions} */
const formStylesOptions = {
  entryPoints: ['src/ui/formView/formApp.css'],
  outfile: 'dist/webview/formApp.css',
  bundle: true,
  minify: production,
  logLevel: 'info',
  loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
};

async function main() {
  const entries = [options, webviewOptions, formStylesOptions];

  if (watch) {
    const ctxs = await Promise.all(entries.map((entry) => esbuild.context(entry)));
    await Promise.all(ctxs.map((ctx) => ctx.watch()));
    copyRuntimeAssets();
    console.log('[esbuild] watching for changes...');
    return;
  }

  for (const entry of entries) {
    await esbuild.build(entry);
  }
  copyRuntimeAssets();

  if (production) {
    for (const entry of entries) {
      const size = fs.statSync(entry.outfile).size;
      console.log(`[esbuild] ${entry.outfile} = ${(size / 1024).toFixed(0)} kB`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
