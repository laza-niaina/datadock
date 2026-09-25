/**
 * Host-side plumbing for the shared DataDock result webview (query results and
 * the table viewer run the same webview application, see resultApp.ts).
 *
 * The webview bundle is compiled by the second esbuild entry into
 * `dist/webview/resultApp.js` (+ `resultApp.css`) and referenced from the page
 * shell with `asWebviewUri`, so `localResourceRoots` stays scoped to that one
 * folder. `configureResultViewRoot` is invoked once at activation; the panels
 * resolve assets lazily through this module.
 */

import * as vscode from 'vscode';
import type { ResultViewAssets } from '../dataGrid/dataGridView';

let extensionRoot: vscode.Uri | undefined;

/** Point the result view at the running extension directory (call once at activation). */
export function configureResultViewRoot(extensionUri: vscode.Uri): void {
  extensionRoot = extensionUri;
}

/** Folder served to the result webviews: `dist/webview` of the current extension. */
export function webviewRootDir(): vscode.Uri | undefined {
  return extensionRoot ? vscode.Uri.joinPath(extensionRoot, 'dist', 'webview') : undefined;
}

/** Panel icon for both result panels (MIT mark reused from the reference repo). */
export function panelIconUri(): vscode.Uri | undefined {
  return extensionRoot ? vscode.Uri.joinPath(extensionRoot, 'resources', 'icon', 'result-panel.svg') : undefined;
}

/** Webview options shared by both result panels: scripts on, resources = bundle folder. */
export function resultViewWebviewOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
  const root = webviewRootDir();
  return {
    enableScripts: true,
    retainContextWhenHidden: false,
    localResourceRoots: root ? [root] : [],
  };
}

export function resultViewAssets(webview: vscode.Webview): ResultViewAssets {
  const root = webviewRootDir();
  const jsUri = root ? webview.asWebviewUri(vscode.Uri.joinPath(root, 'resultApp.js')) : undefined;
  const cssUri = root ? webview.asWebviewUri(vscode.Uri.joinPath(root, 'resultApp.css')) : undefined;
  const cspSource = webview.cspSource;
  return {
    jsUri: jsUri ? jsUri.toString() : '',
    cssUri: cssUri ? cssUri.toString() : '',
    cspSource,
  };
}