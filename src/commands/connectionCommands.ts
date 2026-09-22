/**
 * Connection lifecycle commands: add, edit, duplicate, delete, connect,
 * disconnect, reconnect.
 *
 * Every command resolves its target profile from the invoking tree node when
 * there is one, and falls back to a QuickPick otherwise, which makes the same
 * commands usable from the explorer context menu and from the command palette.
 */

import * as vscode from 'vscode';
import { DbError } from '../db/errors';
import type { ConnectionProfile } from '../db/types';
import { ConnectionNode } from '../explorer/nodes';
import { ConnectionFormPanel, type ConnectionFormOptions } from '../ui/connectionFormPanel';
import type { CommandServices, Register } from './types';

/** Extracts the owning connection id from any explorer node. */
export function connectionIdOf(node: unknown): string | undefined {
  if (node instanceof ConnectionNode) {
    return node.profile.id;
  }
  const candidate = node as { connectionId?: unknown; ref?: { connectionId?: unknown } } | undefined;
  const fromRef = candidate?.ref?.connectionId;
  const direct = candidate?.connectionId;
  if (typeof direct === 'string') {
    return direct;
  }
  return typeof fromRef === 'string' ? fromRef : undefined;
}

/** Resolves the profile a command should act on. */
export async function resolveProfile(
  services: CommandServices,
  node: unknown,
): Promise<ConnectionProfile | undefined> {
  const id = connectionIdOf(node);
  if (id) {
    return services.store.get(id);
  }

  const profiles = await services.store.list();
  if (profiles.length === 0) {
    void vscode.window.showInformationMessage('No database connection has been created yet.');
    return undefined;
  }
  if (profiles.length === 1) {
    return profiles[0];
  }

  const picked = await vscode.window.showQuickPick(
    profiles.map((profile) => ({
      label: profile.name,
      description: profile.host ? `${profile.engine} · ${profile.host}` : profile.engine,
      profile,
    })),
    { title: 'Select a connection', placeHolder: 'Connection' },
  );
  return picked?.profile;
}

function formOptions(services: CommandServices): ConnectionFormOptions {
  return {
    store: services.store,
    manager: services.manager,
    registry: services.registry,
    logger: services.logger,
  };
}

export function registerConnectionCommands(register: Register, services: CommandServices): void {
  register('dbclient.connection.add', async () => {
    const factories = services.registry.available();
    if (factories.length === 0) {
      void vscode.window.showErrorMessage(
        'No database driver is registered in this build, so no connection can be created.',
      );
      return;
    }

    const picked = await vscode.window.showQuickPick(
      factories.map((factory) => ({
        label: factory.label,
        description: factory.fileBased
          ? 'local file'
          : factory.defaultPort
            ? `default port ${factory.defaultPort}`
            : undefined,
        factory,
      })),
      { title: 'Select a database engine', placeHolder: 'Engine' },
    );
    if (!picked) {
      return;
    }

    const factory = picked.factory;
    const profile = services.store.newProfile(factory.engine, factory);
    profile.name = services.store.nextAvailableName(profile.name, await services.store.list());
    ConnectionFormPanel.show(formOptions(services), 'create', profile);
  });

  register('dbclient.connection.edit', async (node?: unknown) => {
    const profile = await resolveProfile(services, node);
    if (profile) {
      ConnectionFormPanel.show(formOptions(services), 'edit', profile);
    }
  });

  register('dbclient.connection.duplicate', async (node?: unknown) => {
    const profile = await resolveProfile(services, node);
    if (!profile) {
      return;
    }
    const copy = await services.store.duplicate(profile.id);
    if (copy) {
      void vscode.window.showInformationMessage(`Created '${copy.name}'.`);
    }
  });

  register('dbclient.connection.delete', async (node?: unknown) => {
    const profile = await resolveProfile(services, node);
    if (!profile) {
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      `Delete the connection '${profile.name}'? Its stored password and keys are erased too.`,
      { modal: true },
      'Delete',
    );
    if (confirmed !== 'Delete') {
      return;
    }
    await services.manager.disconnect(profile.id);
    services.cache.invalidate(`profile:${profile.id}`);
    const removed = await services.store.remove(profile.id);
    if (removed) {
      void vscode.window.showInformationMessage(`Connection '${profile.name}' deleted.`);
    }
  });

  register('dbclient.connection.connect', async (node?: unknown) => {
    const profile = await resolveProfile(services, node);
    if (profile) {
      await connectProfile(services, profile);
    }
  });

  register('dbclient.connection.disconnect', async (node?: unknown) => {
    const id = connectionIdOf(node) ?? (await resolveProfile(services, node))?.id;
    if (id) {
      await services.manager.disconnect(id);
    }
  });

  register('dbclient.connection.reconnect', async (node?: unknown) => {
    const profile = await resolveProfile(services, node);
    if (!profile) {
      return;
    }
    await services.manager.disconnect(profile.id);
    await connectProfile(services, profile);
  });

  register('dbclient.connection.copyName', async (node?: unknown) => {
    const profile = await resolveProfile(services, node);
    if (profile) {
      await vscode.env.clipboard.writeText(profile.name);
    }
  });
}

/** Shared by `connect` and `reconnect`: progress, error reporting, reveal. */
async function connectProfile(services: CommandServices, profile: ConnectionProfile): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Connecting to ${profile.name}…`,
      cancellable: false,
    },
    async () => {
      try {
        const config = await services.store.readConfig(profile.id);
        if (!config) {
          throw new DbError('CONFIG_ERROR', `Connection '${profile.name}' no longer exists.`);
        }
        await services.manager.connect(config);
        await services.revealConnection(profile.id);
      } catch (error) {
        const dbError = DbError.from(error);
        const choice = await vscode.window.showErrorMessage(
          `Could not connect to '${profile.name}': ${dbError.message}`,
          'Show Output',
          'Edit Connection',
        );
        if (choice === 'Show Output') {
          services.showOutput();
        } else if (choice === 'Edit Connection') {
          ConnectionFormPanel.show(formOptions(services), 'edit', profile);
        }
      }
    },
  );
}

