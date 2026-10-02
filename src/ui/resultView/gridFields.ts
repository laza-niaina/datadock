/**
 * Pure column helpers of the result webview.
 *
 * They live outside `resultApp.ts` so the unit tests can lock the behaviour
 * that must never regress: every column the driver returned is a real column
 * (a column literally named `#` or `index` is data, not an artifact), the
 * auto-fit width stays inside its floor and ceiling, and the width-persistence
 * key is a table/column signature that never carries SQL or a cell value.
 */

/** Value shape of one serialized grid cell (see `dataGridModel.serializeGridValue`). */
export type GridCellValue = string | number | null;

/** Column as delivered by the host in the page-shell island. */
export interface GridColumnInit {
  readonly name: string;
  readonly type?: string;
  /** Column is declared PRIMARY KEY on the relation behind the grid. */
  readonly primaryKey?: boolean;
  /** Column is declared FOREIGN KEY on the relation behind the grid. */
  readonly foreignKey?: boolean;
  /** Column accepts NULL, so the editor may offer writing one. */
  readonly nullable?: boolean;
  /** Column is filled in by the engine on insert (identity/serial). */
  readonly autoIncrement?: boolean;
  /** `false` for a column whose values no editor can round-trip (binary). */
  readonly editable?: boolean;
}

/** One rendered column: `field` is the unique row key, `name` what the user reads. */
export interface Field {
  readonly field: string;
  readonly name: string;
  readonly type?: string;
  /** Column is declared PRIMARY KEY on the relation behind the grid. */
  readonly primaryKey?: boolean;
  /** Column is declared FOREIGN KEY on the relation behind the grid. */
  readonly foreignKey?: boolean;
  /** Column accepts NULL, so the editor may offer writing one. */
  readonly nullable?: boolean;
  /** Column is filled in by the engine on insert (identity/serial). */
  readonly autoIncrement?: boolean;
  /** `false` for a column whose values no editor can round-trip (binary). */
  readonly editable?: boolean;
}

/**
 * Maps the driver's columns onto row keys, disambiguating duplicate names.
 *
 * The mapping is one line per returned column: no index column is ever
 * invented, and a column named `#`, `index`, `row_number` or `id` passes
 * through untouched - it is data like any other. The schema key flags travel
 * with the column so a header can mark a real declared key without a second
 * lookup.
 */
export function fieldsFor(columns: readonly GridColumnInit[]): Field[] {
  const seen = new Map<string, number>();
  return columns.map((column) => {
    const count = seen.get(column.name) ?? 0;
    seen.set(column.name, count + 1);
    const primaryKey = column.primaryKey === true || undefined;
    const foreignKey = column.foreignKey === true || undefined;
    const nullable = column.nullable === true || undefined;
    const autoIncrement = column.autoIncrement === true || undefined;
    const editable = column.editable === false ? false : undefined;
    return count === 0
      ? { field: column.name, name: column.name, type: column.type, primaryKey, foreignKey, nullable, autoIncrement, editable }
      : {
          field: `${column.name}__${count}`,
          name: column.name,
          type: column.type,
          primaryKey,
          foreignKey,
          nullable,
          autoIncrement,
          editable,
        };
  });
}

/**
 * Width of a schema key mark in the header: a 12px icon plus its 4px gap,
 * plus 2px of slack.
 *
 * The character estimate below never sees the mark, so a marked column has to
 * be widened by these pixels explicitly. It is added *after* the floor and the
 * ceiling, because folding it into the character count would be swallowed by
 * the 70px floor - which is exactly how a short marked name (`org_id`) ended
 * up the only label cut off by auto-fit. The slack is not decoration either:
 * the column width is an integer while the text inside it is fractional, and
 * a measured `org_id` fell 0.09px short of its box, which is enough to make
 * the ellipsis paint.
 */
const KEY_MARK_WIDTH = 18;

/**
 * Auto-fit width of a column: header/type plus the first loaded rows, in
 * characters scaled to pixels, clamped so neither a tiny column nor a wide
 * text column can distort the grid. Sampling stops after 10 rows on purpose -
 * auto-fit must never read the whole result set.
 */
export function computeWidth(
  field: Field,
  rows: readonly Record<string, GridCellValue>[],
): number {
  let longest = field.name.length;
  if (field.type) {
    longest = Math.max(longest, field.type.length);
  }
  const limit = Math.min(rows.length, 10);
  for (let index = 0; index < limit; index += 1) {
    const value = rows[index][field.field];
    if (value != null) {
      longest = Math.max(longest, String(value).length);
    }
  }
  const auto = Math.min(150, Math.max(70, longest * 10));
  return field.primaryKey || field.foreignKey
    ? Math.min(150, auto + KEY_MARK_WIDTH)
    : auto;
}

/**
 * Persistence key of one grid's manual column widths.
 *
 * The table the statement reads from, or the shape of the result (its column
 * names) when there is no table. Never the SQL text and never a cell value:
 * this key lands in `vscode.setState` (workspace state), so a width preference
 * must not carry a statement or data. Two different databases exposing the
 * same table name share the key on purpose - widths are presentation only.
 */
export function widthSignature(grid: {
  readonly table: string;
  readonly columns: readonly GridColumnInit[];
}): string {
  const table = grid.table.trim();
  if (table !== "") {
    return `table:${table}`;
  }
  const shape = grid.columns.map((column) => column.name).join("\u001f");
  return `shape:${shape}`;
}
