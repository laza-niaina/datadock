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
  ],
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    copyRuntimeAssets();
    console.log('[esbuild] watching for changes...');
    return;
  }

  await esbuild.build(options);
  copyRuntimeAssets();

  if (production && options.metafile) {
    const meta = await esbuild.build({ ...options, metafile: true, write: false });
    const size = fs.statSync(options.outfile).size;
    console.log(`[esbuild] dist/extension.js = ${(size / 1024).toFixed(0)} kB`);
    void meta;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
