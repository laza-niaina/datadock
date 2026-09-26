/**
 * Host-side persistence for the result grid density toggle.
 *
 * Kept out of `dataGridView.ts` on purpose: that module renders the page shell
 * and must stay importable from plain `node --test` unit tests, while these
 * helpers need the real VS Code configuration API.
 */

import * as vscode from 'vscode';

/** Configuration key backing the result grid density toggle. */
export const COMPACT_GRID_SETTING = 'resultGrid.compact';

/** Reads the persisted density preference (default: comfortable rows). */
export function compactGridSetting(): boolean {
  return vscode.workspace.getConfiguration('dbclient').get<boolean>(COMPACT_GRID_SETTING, false);
}

/** Persists the density preference from the webview toggle. */
export async function writeCompactGridSetting(compact: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration('dbclient')
    .update(COMPACT_GRID_SETTING, compact, vscode.ConfigurationTarget.Global);
}
