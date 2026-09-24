/**
 * Explorer-local commands: refresh, cache control, copy name.
 *
 * These operate on the node that was right-clicked, which is why they all take
 * an `unknown` first argument and narrow it themselves.
 */

import * as vscode from 'vscode';
import { ExplorerNode } from '../explorer/nodes';
import type { CommandServices, Register } from './types';

/** Reads the display label of a tree item, whatever shape VS Code gave it. */
export function labelOf(node: unknown): string | undefined {
  const item = node as { label?: unknown } | undefined;
  const label = item?.label;
  if (typeof label === 'string') {
    return label;
  }
  if (label && typeof label === 'object' && 'label' in label) {
    const inner = (label as { label: unknown }).label;
    return typeof inner === 'string' ? inner : undefined;
  }
  return undefined;
}

export function registerExplorerCommands(register: Register, services: CommandServices): void {
  register('dbclient.explorer.refresh', () => {
    services.provider.refreshAll();
  });

  register('dbclient.explorer.clearCache', () => {
    const removed = services.cache.invalidate();
    services.logger.info('Metadata cache cleared.', { entries: removed });
    void vscode.window.showInformationMessage(
      `DataDock: cleared ${removed} cached metadata ${removed === 1 ? 'entry' : 'entries'}.`,
    );
  });

  register('dbclient.explorer.showOutput', () => {
    services.showOutput();
  });

  register('dbclient.node.refresh', (node?: unknown) => {
    if (node instanceof ExplorerNode) {
      services.provider.refreshNode(node);
      return;
    }
    services.provider.refreshAll();
  });

  register('dbclient.node.copyName', async (node?: unknown) => {
    const label = labelOf(node);
    if (label) {
      await vscode.env.clipboard.writeText(label);
    }
  });
}
