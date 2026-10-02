/**
 * Pure ER diagram model.
 *
 * Turns the metadata the explorer already loads (`TableInfo` + `ColumnInfo`)
 * plus the catalog-wide `ForeignKeyInfo` rows into the shape the ERD webview
 * renders. Deliberately free of `vscode`, of the drivers and of any DOM
 * concern, so `node --test` can cover the rules that matter:
 *
 *  - a relationship is only produced when **both** endpoints were loaded, so
 *    filtering schemas or hiding tables can never leave a dangling line;
 *  - the referenced column comes from the engine; when the FK points at the
 *    parent's implicit primary key (`targetColumn === undefined`, SQLite) the
 *    model resolves it to the parent's single PK column, and falls back to the
 *    table header when there is no such column;
 *  - nothing is inferred from naming conventions: a line exists only if the
 *    engine declared a constraint.
 */

import type { ColumnInfo, ForeignKeyInfo, TableInfo } from '../../db/types';

/** One column of an ER table, already carrying its PK/FK indicators. */
export interface ErColumn {
  name: string;
  /** Engine-reported type, e.g. `varchar(255)`. */
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  isAutoIncrement: boolean;
  /** 1-based position inside the relation. */
  ordinal: number;
}

/** One box of the diagram. */
export interface ErTable {
  /** Stable, schema-qualified key (`public.orders`, or `orders` without schema). */
  id: string;
  /** Schema/namespace label when the engine separates them. */
  schema?: string;
  name: string;
  kind: 'table' | 'view';
  columns: ErColumn[];
}

/** One line of the diagram: `source` references `target`. */
export interface ErRelationship {
  id: string;
  /** Engine constraint name, when it has one. */
  constraintName?: string;
  sourceTableId: string;
  sourceColumn: string;
  targetTableId: string;
  /** Resolved referenced column, or `undefined` when the target has no PK. */
  targetColumn?: string;
  /** 1-based position inside a composite constraint. */
  ordinal: number;
}

export interface ErDiagram {
  /** Sorted by schema then name, so any two renders of the same data match. */
  tables: ErTable[];
  /** Sorted by id, for the same reason. */
  relationships: ErRelationship[];
}

/** A relation (table or view) with its columns, as loaded by the panel. */
export interface ErRelationInput {
  schema?: string;
  table: TableInfo;
  columns: ColumnInfo[];
}

export interface ErDiagramInput {
  relations: ErRelationInput[];
  foreignKeys: ForeignKeyInfo[];
}

/** Stable key of a table box; the schema keeps same-named tables apart. */
export function erTableId(schema: string | undefined, name: string): string {
  const scope = schema?.trim();
  return scope === undefined || scope === '' ? name : `${scope}.${name}`;
}

/**
 * Whether a table and a constraint row live in the same scope.
 *
 * Engines without schemas (MySQL, SQLite) leave one of the two sides
 * undefined; a comparison only constrains when **both** sides carry a schema,
 * which is what lets a single-scope engine match its `REFERENCED_*_SCHEMA`
 * columns against schema-less tables.
 */
function schemaMatches(tableSchema: string | undefined, fkSchema: string | undefined): boolean {
  const table = tableSchema?.trim() || undefined;
  const fk = fkSchema?.trim() || undefined;
  return table === undefined || fk === undefined || table === fk;
}

function toErColumn(column: ColumnInfo): ErColumn {
  return {
    name: column.name,
    dataType: column.dataType,
    nullable: column.nullable,
    isPrimaryKey: column.isPrimaryKey,
    isForeignKey: column.isForeignKey,
    isAutoIncrement: column.isAutoIncrement,
    ordinal: column.ordinal,
  };
}

/** The single primary-key column of a table, when it has exactly one. */
function singlePrimaryKey(table: ErTable): string | undefined {
  const keys = table.columns.filter((column) => column.isPrimaryKey);
  return keys.length === 1 ? keys[0].name : undefined;
}

/**
 * Builds the diagram.
 *
 * Relations are sorted before anything else so the output depends only on the
 * input set, never on the order the metadata cache happened to return.
 */
export function buildErDiagram(input: ErDiagramInput): ErDiagram {
  const tables: ErTable[] = input.relations
    .map((relation) => ({
      id: erTableId(relation.schema, relation.table.name),
      schema: relation.schema?.trim() || undefined,
      name: relation.table.name,
      kind: relation.table.kind === 'view' ? ('view' as const) : ('table' as const),
      columns: relation.columns.map(toErColumn),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const byId = new Map<string, ErTable>(tables.map((table) => [table.id, table]));

  const relationships = resolveRelationships(input.foreignKeys, byId, tables);
  return { tables, relationships };
}

/** Drops foreign keys whose endpoints were not loaded and resolves the target column. */
function resolveRelationships(
  keys: readonly ForeignKeyInfo[],
  byId: Map<string, ErTable>,
  tables: readonly ErTable[],
): ErRelationship[] {
  const byName = new Map<string, ErTable>();
  for (const table of tables) {
    if (!byName.has(table.name)) {
      byName.set(table.name, table);
    }
  }

  const relationships: ErRelationship[] = [];
  const seen = new Map<string, number>();

  for (const key of keys) {
    const source = findTable(key.sourceSchema, key.sourceTable, byId, byName);
    const target = findTable(key.targetSchema, key.targetTable, byId, byName);
    if (!source || !target) {
      // One endpoint is outside the loaded schemas: no line is drawn rather
      // than a line pointing at a box that does not exist.
      continue;
    }
    if (!source.columns.some((column) => column.name === key.sourceColumn)) {
      continue;
    }

    // The engine names the referenced column when it knows it; SQLite reports
    // `NULL` for a constraint pointing at the parent's implicit rowid PK, so
    // fall back to the target's single primary key (or the header if none).
    const targetColumn = key.targetColumn ?? singlePrimaryKey(target);

    const base = `${source.id}:${key.sourceColumn}->${target.id}:${targetColumn ?? '*'}`;
    const seed = key.name ? `${key.name}:${base}` : base;
    const hits = (seen.get(seed) ?? 0) + 1;
    seen.set(seed, hits);

    relationships.push({
      id: hits === 1 ? seed : `${seed}#${hits}`,
      constraintName: key.name,
      sourceTableId: source.id,
      sourceColumn: key.sourceColumn,
      targetTableId: target.id,
      targetColumn,
      ordinal: key.ordinal,
    });
  }

  relationships.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // FK rows carry the participating column: mark it even when the engine's
  // column query reported no flag (a schema-wide listing can happen).
  for (const relationship of relationships) {
    const source = byId.get(relationship.sourceTableId);
    const column = source?.columns.find((item) => item.name === relationship.sourceColumn);
    if (column) {
      column.isForeignKey = true;
    }
  }
  return relationships;
}

/** Resolves a table by schema-qualified id first, then by bare name. */
function findTable(
  schema: string | undefined,
  name: string,
  byId: Map<string, ErTable>,
  byName: Map<string, ErTable>,
): ErTable | undefined {
  const direct = byId.get(erTableId(schema, name));
  if (direct && schemaMatches(direct.schema, schema)) {
    return direct;
  }
  const fallback = byName.get(name);
  return fallback && schemaMatches(fallback.schema, schema) ? fallback : undefined;
}

/** Ids of every table taking part in at least one relationship. */
export function relatedTableIds(diagram: ErDiagram): Set<string> {
  const ids = new Set<string>();
  for (const relationship of diagram.relationships) {
    ids.add(relationship.sourceTableId);
    ids.add(relationship.targetTableId);
  }
  return ids;
}

/** Toolbar counters: `N tables`, `M relationships`. */
export function erDiagramStats(diagram: ErDiagram): { tables: number; relationships: number } {
  return { tables: diagram.tables.length, relationships: diagram.relationships.length };
}
