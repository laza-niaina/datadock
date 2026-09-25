/**
 * Connection form panel.
 *
 * A single reusable webview per profile id. The host keeps secrets: the webview
 * only ever receives booleans describing whether a secret exists, never the
 * value itself, so a compromised webview cannot exfiltrate stored credentials.
 */

import * as vscode from 'vscode';
import type { ConnectionManager } from '../connections/connectionManager';
import type { ConnectionStore } from '../connections/connectionStore';
import type { DriverRegistry } from '../db/driverRegistry';
import { DbError } from '../db/errors';
import type { ConnectionProfile, ConnectionSecrets, Logger } from '../db/types';
import {
  draftFromProfile,
  emptyDraft,
  emptySecretPresence,
  profileFromDraft,
  secretsFromDraft,
  type FormDraft,
} from './connectionDraft';
import {
  renderConnectionFormHtml,
  type ConnectionFormModel,
  type EngineChoice,
} from './connectionFormHtml';
import { getEngineIcon } from './icons';

/** Messages sent from the webview to the extension host. */
type InboundMessage =
  | { type: 'ready' }
  | { type: 'save'; draft: FormDraft }
  | { type: 'test'; draft: FormDraft }
  | { type: 'cancel' }
  | { type: 'pickFile'; target: string };

/** Messages sent from the extension host to the webview. */
type OutboundMessage =
  | ({ type: 'init' } & ConnectionFormModel)
  | { type: 'busy'; busy: boolean; label?: string }
  | { type: 'testResult'; ok: boolean; message: string }
  | { type: 'error'; message: string }
  | { type: 'notice'; message: string }
  | { type: 'filePicked'; target: string; value: string };

const PANEL_VIEW_TYPE = 'dbclient.connectionForm';
const FILE_TARGETS = new Set(['filePath', 'sslCaFile', 'sslCertFile', 'sslKeyFile', 'sshPrivateKeyPath']);

export interface ConnectionFormOptions {
  store: ConnectionStore;
  manager: ConnectionManager;
  registry: DriverRegistry;
  logger: Logger;
  /** Called after a profile was created or updated. */
  onSaved?: (profile: ConnectionProfile) => void | Promise<void>;
}

export class ConnectionFormPanel {
  /** One panel per profile and mode, so a repeated command reveals instead of stacking. */
  private static readonly open = new Map<string, ConnectionFormPanel>();

  private readonly disposables: vscode.Disposable[] = [];
  private baseProfile: ConnectionProfile;
  private draft: FormDraft;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly options: ConnectionFormOptions,
    private readonly mode: 'create' | 'edit',
    baseProfile: ConnectionProfile,
    private readonly key: string,
  ) {
    this.baseProfile = baseProfile;
    this.draft =
      mode === 'create'
        ? emptyDraft(baseProfile.id, baseProfile.engine, options.registry.get(baseProfile.engine))
        : draftFromProfile(baseProfile);

    this.panel.webview.html = renderConnectionFormHtml(this.panel.webview);

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: InboundMessage) => {
        void this.onMessage(message);
      }),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  /**
   * Opens (or reveals) the form.
   * Returns `undefined` when no driver is available, in which case a message has
   * already been shown: creating a connection that cannot be opened would be a
   * dead end.
   */
  static show(
    options: ConnectionFormOptions,
    mode: 'create' | 'edit',
    baseProfile: ConnectionProfile,
  ): ConnectionFormPanel | undefined {
    if (options.registry.available().length === 0) {
      void vscode.window.showErrorMessage(
        'No database driver is registered in this build, so a connection cannot be created or edited.',
      );
      return undefined;
    }

    const key = `${mode}:${baseProfile.id}`;
    const existing = ConnectionFormPanel.open.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      mode === 'create' ? `New Connection - ${baseProfile.engine}` : `Edit Connection - ${baseProfile.name}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [] },
    );

    const instance = new ConnectionFormPanel(panel, options, mode, baseProfile, key);
    ConnectionFormPanel.open.set(key, instance);
    return instance;
  }

  // -- message handling ----------------------------------------------------

  private async onMessage(message: InboundMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          await this.sendInit();
          return;
        case 'cancel':
          this.panel.dispose();
          return;
        case 'pickFile':
          await this.pickFile(message.target);
          return;
        case 'save':
          await this.save(message.draft);
          return;
        case 'test':
          await this.testConnection(message.draft);
          return;
        default:
          return;
      }
    } catch (error) {
      const dbError = DbError.from(error);
      // `DbError.message` may contain server text; the logger and the redactor
      // guarantee no credential can reach either the log or the webview.
      this.options.logger.error('Connection form error.', { code: dbError.code, message: dbError.message });
      await this.post({ type: 'error', message: dbError.message });
    }
  }

  private async sendInit(): Promise<void> {
    const secretPresence =
      this.mode === 'edit'
        ? await this.options.store.secretPresence(this.baseProfile.id)
        : emptySecretPresence();

    await this.post({
      type: 'init',
      mode: this.mode,
      engines: this.engineChoices(),
      draft: this.draft,
      secretPresence,
    });
  }

  private engineChoices(): EngineChoice[] {
    const available = this.options.registry.available();
    if (available.length > 0) {
      return available.map((factory) => ({
        id: factory.engine,
        label: factory.label,
        logo: getEngineIcon(factory.engine).svg,
        status: factory.status,
        defaultPort: factory.defaultPort,
        fileBased: factory.fileBased,
      }));
    }
    // Fallback: keep the current engine selectable so an existing profile can
    // still be inspected even when its driver failed to register.
    return [
      {
        id: this.baseProfile.engine,
        label: `${this.baseProfile.engine} (driver unavailable)`,
        logo: getEngineIcon(this.baseProfile.engine).svg,
        status: 'planned',
        fileBased: false,
      },
    ];
  }

  private async pickFile(target: string): Promise<void> {
    if (!FILE_TARGETS.has(target)) {
      return;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Select',
      title: 'Select a file',
    });
    const uri = picked?.[0];
    if (!uri) {
      return;
    }
    await this.post({ type: 'filePicked', target, value: uri.fsPath });
  }

  // -- actions -------------------------------------------------------------

  private async save(draft: FormDraft): Promise<void> {
    const profile = profileFromDraft(draft, this.baseProfile);
    const factory = this.options.registry.get(profile.engine);

    await this.post({ type: 'busy', busy: true, label: 'Saving…' });
    try {
      const saved = await this.options.store.save(profile, factory);
      // Secrets are written only after the profile is safely persisted.
      await this.options.store.applySecretUpdate(saved.id, secretsFromDraft(draft));

      this.baseProfile = saved;
      this.draft = { ...draft, password: '', sshPassword: '', sshPrivateKey: '', sshPassphrase: '' };
      this.options.manager.refreshProfile(saved);
      await this.options.onSaved?.(saved);

      this.panel.title = `Edit Connection - ${saved.name}`;
      this.options.logger.info(`Connection '${saved.name}' saved from the connection form.`, { id: saved.id });
      await this.post({ type: 'testResult', ok: true, message: `Saved '${saved.name}'.` });
      // The stored secrets may now exist, so the hints must be refreshed.
      await this.sendInit();
    } catch (error) {
      const dbError = DbError.from(error, 'CONFIG_ERROR');
      await this.post({ type: 'error', message: dbError.message });
    } finally {
      await this.post({ type: 'busy', busy: false });
    }
  }

  private async testConnection(draft: FormDraft): Promise<void> {
    const profile = profileFromDraft(draft, this.baseProfile);

    await this.post({ type: 'busy', busy: true, label: 'Testing connection…' });
    try {
      const secrets = await this.mergeSecrets(draft);
      const result = await this.options.manager.test({ profile, secrets });

      if (result.ok) {
        const parts = [`Connected successfully in ${result.latencyMs ?? '?'} ms.`];
        if (result.databaseCount !== undefined) {
          parts.push(`${result.databaseCount} database(s) visible.`);
        }
        await this.post({ type: 'testResult', ok: true, message: parts.join(' ') });
      } else {
        const message = result.error
          ? `${result.error.hint}\n\n${result.error.message}`
          : 'The connection could not be established.';
        await this.post({ type: 'testResult', ok: false, message });
      }
    } finally {
      await this.post({ type: 'busy', busy: false });
    }
  }

  /**
   * Combines the stored secrets with what was just typed.
   * Typed values win; an explicit clear removes the field. Nothing is written.
   */
  private async mergeSecrets(draft: FormDraft): Promise<ConnectionSecrets> {
    const update = secretsFromDraft(draft);
    const stored =
      this.mode === 'edit' ? await this.options.store.getSecrets(this.baseProfile.id) : {};
    const merged: ConnectionSecrets = { ...stored, ...update.set };
    for (const field of update.clear) {
      delete merged[field];
    }
    return merged;
  }

  private async post(message: OutboundMessage): Promise<void> {
    await this.panel.webview.postMessage(message);
  }

  dispose(): void {
    ConnectionFormPanel.open.delete(this.key);
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

