/**
 * Command registration entry point.
 *
 * Kept as a single funnel so `extension.ts` has exactly one call to make and the
 * list of registered ids stays easy to audit against `package.json`.
 */

import * as vscode from 'vscode';
import { registerConnectionCommands } from './connectionCommands';
import { registerExplorerCommands } from './explorerCommands';
import type { CommandServices, Register } from './types';

export type { CommandServices } from './types';

export function registerCommands(context: vscode.ExtensionContext, services: CommandServices): void {
  const register: Register = (commandId, handler) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(commandId, (...args: unknown[]) => handler(...args)),
    );
  };

  registerConnectionCommands(register, services);
  registerExplorerCommands(register, services);
}
