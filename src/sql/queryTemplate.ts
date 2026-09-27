/**
 * SQL templates for editor entry points.
 *
 * Pure, `vscode`-free strings so the generated statement can be asserted by
 * `node --test` and reused by any command that opens a prefilled editor.
 */

import type { EngineId } from '../db/types';

/** Identifiers a table node knows about, in most specific first order. */
export interface RelationTarget {
  readonly table: string;
  readonly schema?: string;
  readonly database?: string;
}

/**
 * Quotes one identifier with the engine's own quoting rules.
 * Only backtick quoting is MySQL/MariaDB specific; the rest accept ANSI double
 * quotes, which is also what the SQLite and SQL Server grammars read.
 */
export function quoteIdentifier(name: string, engine: EngineId): string {
  if (engine === 'mysql' || engine === 'mariadb') {
    return `\`${name.replace(/`/g, '``')}\``;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/** `schema.table` or `table`, each part quoted for the engine. */
export function qualifiedRelationName(target: RelationTarget, engine: EngineId): string {
  const parts = target.schema ? [target.schema, target.table] : [target.table];
  return parts.map((part) => quoteIdentifier(part, engine)).join('.');
}

/**
 * The statement a tree node opens in a new SQL editor.
 *
 * It is a read-only scaffold on purpose: no `LIMIT` and no `USE` statement, so
 * the executed text stays exactly what the user sees and the database keeps
 * coming from the file context rather than from an injected command.
 */
export function selectStatementFor(target: RelationTarget, engine: EngineId): string {
  const where = target.database ? ` · ${target.database}` : '';
  return [
    `-- DataDock: ${engine}${where}`,
    `SELECT *`,
    `FROM ${qualifiedRelationName(target, engine)};`,
  ].join('\n');
}
