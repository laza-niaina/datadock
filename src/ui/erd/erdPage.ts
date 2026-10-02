/**
 * Strict-CSP page shell of the DataDock entity relationship diagram webview.
 *
 * Mirrors `renderDataGridPage` for the result view: a nonce-protected CSP, a
 * JSON island carrying the static identity of the panel (connection, database,
 * engine) and the ERD bundle compiled by the fourth esbuild entry into
 * `dist/webview/erdApp.js` (+ `erdApp.css`).
 *
 * Deliberately free of any `vscode` import: `node --test` asserts the CSP, the
 * island and the asset tags directly.
 */

import { randomBytes } from 'node:crypto';
import { escapeHtml, jsonForScript, type ResultViewAssets } from '../dataGrid/dataGridView';
import type { ErIsland } from './erdProtocol';

export type { ErIsland as ErPageOptions };

/**
 * Renders the page shell that boots the ERD bundle.
 *
 * Order matters: the nonce island is declared before the external bundle so the
 * app can read its identity on first evaluation.
 */
export function renderErPage(assets: ResultViewAssets, options: ErIsland, pageTitle: string): string {
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `style-src ${assets.cspSource} 'nonce-${nonce}'`,
    `script-src ${assets.cspSource} 'nonce-${nonce}'`,
    `img-src ${assets.cspSource} data:`,
    "font-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(pageTitle)}</title>
  <link rel="stylesheet" href="${escapeHtml(assets.cssUri)}" />
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}">globalThis.__DATADOCK_ERD__=${jsonForScript(options)};</script>
  <script src="${escapeHtml(assets.jsUri)}"></script>
</body>
</html>`;
}
