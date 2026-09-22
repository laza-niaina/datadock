/**
 * Output-panel logger.
 *
 * Two guarantees hold for every message:
 *  - it is passed through the shared `Redactor`, so registered passwords,
 *    private keys and credential-shaped substrings can never be printed;
 *  - object arguments are rendered through `safeStringify`, so a circular
 *    structure or a 50 MB result set cannot break logging.
 *
 * A plain `OutputChannel` is used rather than a `LogOutputChannel` on purpose:
 * `LogOutputChannel.logLevel` is read-only, so it cannot be driven by the
 * `dbclient.log.level` setting, and having the native log level *and* a setting
 * silently filter each other is worse than one predictable control.
 */

import * as vscode from 'vscode';
import type { Logger, LogLevel } from '../db/types';
import { safeStringify } from '../util/format';
import { globalRedactor, type Redactor } from '../util/redaction';

/** Lower number = more severe. A message is printed when `level <= configured`. */
const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

const LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace'];

export function toLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  const normalised = value?.trim().toLowerCase();
  return LEVELS.find((level) => level === normalised) ?? fallback;
}

export class OutputLogger implements Logger, vscode.Disposable {
  private readonly channel: vscode.OutputChannel;
  private level: LogLevel = 'info';

  constructor(
    private readonly redactor: Redactor = globalRedactor,
    title = 'Database Client',
  ) {
    this.channel = vscode.window.createOutputChannel(title);
  }

  /** Exposed so the UI can offer "Show Output" and reveal the channel. */
  get outputChannel(): vscode.OutputChannel {
    return this.channel;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  /** True when a message at `level` would currently be printed. */
  isEnabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] <= LEVEL_ORDER[this.level];
  }

  error(message: string, ...args: unknown[]): void {
    this.write('error', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.write('warn', message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.write('info', message, args);
  }

  debug(message: string, ...args: unknown[]): void {
    this.write('debug', message, args);
  }

  trace(message: string, ...args: unknown[]): void {
    this.write('trace', message, args);
  }

  show(preserveFocus = true): void {
    this.channel.show(preserveFocus);
  }

  dispose(): void {
    this.channel.dispose();
  }

  private write(level: LogLevel, message: string, args: unknown[]): void {
    if (!this.isEnabled(level)) {
      return;
    }
    this.channel.appendLine(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${this.render(message, args)}`);
  }

  private render(message: string, args: unknown[]): string {
    const body = args.length === 0 ? message : `${message} ${args.map((arg) => safeStringify(arg)).join(' ')}`;
    return this.redactor.redact(body);
  }
}
