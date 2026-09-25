/**
 * Host-side page renderer for the DataDock result webview.
 *
 * Both result panels (query results, table viewer) share the same webview
 * bundle (`dist/webview/resultApp.js` + `resultApp.css`, compiled by the second
 * esbuild entry) and a page shell produced here under a strict CSP. Grid data
 * is serialized once into a JSON island (`globalThis.__DATADOCK_RESULT__`)
 * whose `<` is escaped so no `</script>` sequence can break out of it; the
 * bundle boots from `asWebviewUri` resources resolved by resultHost.ts and
 * talks back to the host through typed navigation/export intents only.
 *
 * Security guarantees:
 *  - the CSP has no remote or unsafe sources and blocks fonts, base and form
 *    actions (element-icons is therefore inert);
 *  - every dynamic string is HTML-escaped before it enters the markup;
 *  - embedded data is serialized `GridCell` values only (no credentials);
 *  - the webview posts intents; the host resolves them.
 */

import { randomBytes } from 'node:crypto';
import type { GridCell, GridColumn, GridFilter, GridSort } from './dataGridModel';
import type { EngineId } from '../../db/types';

/** One grid the page can show (query batches have several, tables one). */
export interface GridViewGrid {
  /** Stable id used by the client script and export messages. */
  readonly id: string;
  /** Unqualified table name used for SQL INSERT exports ('' disables SQL). */
  readonly table: string;
  readonly columns: readonly GridColumn[];
  readonly rows: readonly (readonly GridCell[])[];
  /** Tab label in query batches, e.g. `#1`, `#2.1`. */
  readonly label: string;
  readonly status: 'ok' | 'error' | 'mutation' | 'skipped';
  readonly error?: string;
  readonly durationMs?: number;
  readonly rowsAffected?: number;
  /** Original statement text (tab tooltip). */
  readonly statementSql?: string;
  /** Statement range for "open in SQL file". */
  readonly reveal?: { start: number; end: number };
  readonly truncated?: boolean;
}

export type DataGridMode = 'query' | 'table';

/** Batch-level summary rendered in the page head (query mode only). */
export interface QueryBatchMeta {
  readonly connectionName: string;
  readonly database?: string;
  readonly statementCount: number;
  readonly executedCount: number;
  readonly durationMs: number;
  readonly hasError: boolean;
  readonly notices: readonly string[];
}

export interface DataGridViewOptions {
  readonly mode: DataGridMode;
  readonly grids: readonly GridViewGrid[];
  /** Index of the initially visible grid. */
  readonly activeIndex: number;
  /** Filters already applied host-side (table mode) or client-side (query). */
  readonly filters?: readonly GridFilter[];
  readonly sort?: GridSort;
  readonly search?: string;
  /** 0-based page index for the pager display (table mode). */
  readonly pageIndex?: number;
  /** Rows per page; matches `TableDataRequest.limit` for the pager math. */
  readonly pageSize?: number;
  readonly pageCount?: number;
  /** Total row count across pages when known (table mode `Total`). */
  readonly totalRows?: number;
  /** Static toolbar duration text, e.g. `Cost: 12ms`. */
  readonly cost?: string;
  /** Engine whose brand mark is shown in the toolbar, when known. */
  readonly engine?: EngineId;
  /** Query-mode batch summary rendered in the page head. */
  readonly query?: QueryBatchMeta;
}

/** URLs consumed by the page shell, resolved by resultHost.resultViewAssets. */
export interface ResultViewAssets {
  readonly jsUri: string;
  readonly cssUri: string;
  readonly cspSource: string;
}

/** Extracts a short table name for SQL INSERT exports from a query. */
export function tableFromStatement(sql: string): string {
  const withoutComments = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*\n/g, '\n')
    .replace(/\s+/g, ' ');
  // Accepts `quoted names` (with spaces), schema-qualified names and bare ones.
  const tablePattern = /(?:`([^`]+)`|(?:(?:[\w$]+|`[^`]+`)\.)?(?:`([^`]+)`|([A-Za-z_][\w$]*)))/.source;
  const from = new RegExp(`\\bFROM\\s+${tablePattern}`, 'i').exec(withoutComments);
  if (from) {
    return from[1] ?? from[2] ?? from[3] ?? '';
  }
  const into = new RegExp(`\\bINTO\\s+${tablePattern}`, 'i').exec(withoutComments);
  return into ? into[1] ?? into[2] ?? into[3] ?? '' : '';
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON safe for embedding inside a `<script>` island. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, (m) => `\\u${m.charCodeAt(0).toString(16)}`);
}

/**
 * Renders the strict-CSP page shell that boots the result webview bundle.
 *
 * Order matters: the nonce island (`globalThis.__DATADOCK_RESULT__`) is
 * declared before the external bundle script so the app reads its data on first
 * evaluation.
 */
export function renderDataGridPage(assets: ResultViewAssets, options: DataGridViewOptions, pageTitle: string): string {
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
  <script nonce="${nonce}">globalThis.__DATADOCK_RESULT__=${jsonForScript(options)};</script>
  <script src="${escapeHtml(assets.jsUri)}"></script>
</body>
</html>`;
}