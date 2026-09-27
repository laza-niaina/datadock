/**
 * DB Explorer quick open and tree presentation helpers (the DataDock take on
 * DBCode's "Quick Open" / "Filter" entries in the DB Explorer docs).
 *
 * Everything here is pure so `node --test` can lock the behaviour without VS
 * Code or a live connection: given the list of connected profiles and the
 * driver-facing listing functions, it produces the flat QuickPick items for
 * "Go to Table" and the display description for the object folders.
 */

import type { RelationKind, SchemaRef, TableInfo } from '../db/types';

/** One searchable database object (table, view or collection). */
export interface ExplorerObjectItem {
  readonly connectionId: string;
  readonly connectionName: string;
  readonly database: string;
  readonly schema?: string;
  readonly table: string;
  readonly kind: RelationKind;
  readonly tableType?: string;
  readonly comment?: string;
}

/** QuickPick item shape produced by `explorerObjectItems` consumers. */
export interface ExplorerQuickPickItem {
  readonly item: ExplorerObjectItem;
  label: string;
  description: string;
  detail: string;
}

/** Path segments of an object entry, used for stable QuickPick identity. */
export function qualifiedName(parts: {
  database: string;
  schema?: string;
  table?: string;
}): string {
  const segments = [parts.database, parts.schema, parts.table].filter(
    (part) => part !== undefined && part !== '',
  );
  return segments.join('.');
}

/**
 * Flattens every connected profile into searchable object items.
 * Databases that fail to list are skipped so one broken connection does not
 * hide the objects of the healthy ones; `onError` receives every such failure
 * so the caller can log it instead of silently returning a short list.
 */
export function explorerObjectItems(
  profiles: ReadonlyArray<{ id: string; name: string; database?: string }>,
  listTables: (ref: SchemaRef) => Promise<TableInfo[]>,
  onError?: (connectionId: string, error: unknown) => void,
): Promise<ExplorerObjectItem[]> {
  const items: ExplorerObjectItem[] = [];
  return profiles
    .reduce<Promise<void>>(
      (chain, profile) =>
        chain.then(async () => {
          const database = profile.database ?? profile.name;
          try {
            const tables = await listTables({ connectionId: profile.id, database });
            for (const relation of tables) {
              items.push({
                connectionId: profile.id,
                connectionName: profile.name,
                database,
                table: relation.name,
                kind: relation.kind,
                tableType: relation.tableType,
                comment: relation.comment,
              });
            }
          } catch (error) {
            // Unreachable connection: its tables are simply not searchable, and
            // the caller decides whether that deserves a log line.
            onError?.(profile.id, error);
          }
        }),
      Promise.resolve(),
    )
    .then(() => items);
}

/** Case-insensitive fuzzy subsequence match; returns `undefined` when no match. */
export function fuzzyScore(needle: string, haystack: string): number | undefined {
  const pattern = needle.toLowerCase();
  const target = haystack.toLowerCase();
  if (pattern === '') {
    return 0;
  }
  let score = 0;
  let cursor = 0;
  let streak = 0;
  for (const char of pattern) {
    const found = target.indexOf(char, cursor);
    if (found === -1) {
      return undefined;
    }
    score += found === cursor ? 2 + streak : 1;
    streak = found === cursor ? streak + 1 : 0;
    score += found === 0 ? 3 : 0;
    cursor = found + 1;
  }
  // Compact matches (few gaps) rank higher.
  score -= Math.floor(cursor - pattern.length) / 2;
  // An exact match beats every prefix match of the same pattern.
  if (target.length === pattern.length) {
    score += 4;
  }
  return score;
}

/** Best score of the query against the table name, its schema or the connection. */
export function matchObject(query: string, item: ExplorerObjectItem): number | undefined {
  const name = fuzzyScore(query, item.table);
  const database = fuzzyScore(query, item.database);
  const connection = fuzzyScore(query, item.connectionName);
  const candidates = [name, database, connection].filter(
    (value): value is number => value !== undefined,
  );
  if (candidates.length === 0) {
    return undefined;
  }
  const best = Math.max(...candidates);
  return name !== undefined ? best + 2 : best;
}

/** Filters and ranks items for the QuickPick (best first, then by name). */
export function filterExplorerObjects(
  query: string,
  items: readonly ExplorerObjectItem[],
): ExplorerObjectItem[] {
  const ranked: Array<{ item: ExplorerObjectItem; score: number }> = [];
  for (const item of items) {
    const score = matchObject(query, item);
    if (score !== undefined) {
      ranked.push({ item, score });
    }
  }
  ranked.sort(
    (a, b) => b.score - a.score || a.item.table.localeCompare(b.item.table),
  );
  return ranked.map((entry) => entry.item);
}

/** QuickPick presentation for one object. */
export function toQuickPickItem(item: ExplorerObjectItem): ExplorerQuickPickItem {
  const kind = item.kind === 'view' ? 'view' : item.kind === 'collection' ? 'collection' : 'table';
  return {
    item,
    label: `$(${kind === 'view' ? 'eye' : kind === 'collection' ? 'server' : 'table'}) ${item.table}`,
    description: qualifiedName(item),
    detail: item.comment ? `${item.connectionName} · ${item.comment}` : item.connectionName,
  };
}

/**
 * `Tables (12)` folder description, the DB Explorer shape: the count sits
 * behind the folder word so the row stays readable when the tree is narrow.
 * Only rendered once the listing is known, never as a speculative `0`.
 */
export function folderCountLabel(folder: string, count: number): string {
  const word = folder.charAt(0).toUpperCase() + folder.slice(1);
  return `${word} (${count})`;
}

/** Singular/plural folder tooltip, DB Explorer style. */
export function folderTooltip(folder: string, count: number): string {
  const word = count === 1 ? folder.replace(/s$/, '') : folder;
  return `${count} ${word.toLowerCase()}`;
}
