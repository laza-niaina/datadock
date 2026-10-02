import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ERD_MARGIN,
  ERD_TABLE_WIDTH,
  erTableHeight,
  erTableSize,
  layoutErDiagram,
} from '../../src/ui/erd/erdLayout';
import { buildErDiagram, type ErRelationInput } from '../../src/ui/erd/erdModel';
import type { ColumnInfo, ForeignKeyInfo, TableInfo } from '../../src/db/types';

function column(name: string, overrides: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name,
    dataType: 'int',
    nullable: false,
    isPrimaryKey: false,
    isForeignKey: false,
    isAutoIncrement: false,
    ordinal: 1,
    ...overrides,
  };
}

function relation(name: string, columns: ColumnInfo[]): ErRelationInput {
  const table: TableInfo = { name, kind: 'table' };
  return { table, columns };
}

const shop: ErRelationInput[] = [
  relation('users', [column('id', { isPrimaryKey: true }), column('email')]),
  relation('orders', [
    column('id', { isPrimaryKey: true }),
    column('user_id', { ordinal: 2 }),
    column('total', { ordinal: 3 }),
  ]),
  relation('products', [column('id', { isPrimaryKey: true }), column('sku')]),
  relation('order_items', [
    column('id', { isPrimaryKey: true }),
    column('order_id', { ordinal: 2 }),
    column('product_id', { ordinal: 3 }),
    column('quantity', { ordinal: 4 }),
  ]),
];

const shopKeys: ForeignKeyInfo[] = [
  { sourceTable: 'order_items', sourceColumn: 'order_id', targetTable: 'orders', targetColumn: 'id', ordinal: 1 },
  { sourceTable: 'order_items', sourceColumn: 'product_id', targetTable: 'products', targetColumn: 'id', ordinal: 1 },
  { sourceTable: 'orders', sourceColumn: 'user_id', targetTable: 'users', targetColumn: 'id', ordinal: 1 },
];

describe('erTableHeight / erTableSize', () => {
  it('adds one row per column on top of the header', () => {
    assert.equal(erTableHeight(0), 32 + 24);
    assert.equal(erTableHeight(3), 32 + 3 * 24);
    assert.deepEqual(erTableSize(3), { width: ERD_TABLE_WIDTH, height: erTableHeight(3) });
  });
});

describe('layoutErDiagram', () => {
  it('returns exactly one position per table, never more', () => {
    const diagram = buildErDiagram({ relations: shop, foreignKeys: shopKeys });
    const positions = layoutErDiagram(diagram);
    assert.deepEqual(Object.keys(positions).sort(), diagram.tables.map((table) => table.id).sort());
  });

  it('keeps every box at or beyond the margin (no negative coordinates)', () => {
    const diagram = buildErDiagram({ relations: shop, foreignKeys: shopKeys });
    const positions = layoutErDiagram(diagram);
    for (const [id, position] of Object.entries(positions)) {
      assert.ok(position.x >= ERD_MARGIN, `${id} x=${position.x}`);
      assert.ok(position.y >= ERD_MARGIN, `${id} y=${position.y}`);
    }
  });

  it('never overlaps two boxes', () => {
    const diagram = buildErDiagram({ relations: shop, foreignKeys: shopKeys });
    const positions = layoutErDiagram(diagram);
    const boxes = diagram.tables.map((table) => {
      const size = erTableSize(table.columns.length);
      return { id: table.id, ...positions[table.id], ...size };
    });
    for (let a = 0; a < boxes.length; a += 1) {
      for (let b = a + 1; b < boxes.length; b += 1) {
        const one = boxes[a];
        const two = boxes[b];
        const separated =
          one.x + one.width <= two.x ||
          two.x + two.width <= one.x ||
          one.y + one.height <= two.y ||
          two.y + two.height <= one.y;
        assert.ok(separated, `${one.id} overlaps ${two.id}`);
      }
    }
  });

  it('is deterministic: the same diagram always gets the same positions', () => {
    const forward = buildErDiagram({ relations: shop, foreignKeys: shopKeys });
    const backward = buildErDiagram({ relations: [...shop].reverse(), foreignKeys: [...shopKeys].reverse() });
    assert.deepEqual(layoutErDiagram(forward), layoutErDiagram(backward));
  });

  it('places a table without relationships below the related block', () => {
    const relations = [...shop, relation('audit_log', [column('id', { isPrimaryKey: true }), column('note')])];
    const diagram = buildErDiagram({ relations, foreignKeys: shopKeys });
    const positions = layoutErDiagram(diagram);
    const isolated = positions['audit_log'];
    assert.ok(isolated);
    const relatedBottom = Math.max(
      ...diagram.tables
        .filter((table) => table.id !== 'audit_log')
        .map((table) => positions[table.id].y + erTableHeight(table.columns.length)),
    );
    assert.ok(isolated.y > relatedBottom, `isolated y=${isolated.y} vs bottom=${relatedBottom}`);
  });

  it('lays out a graph with no relationships at all as a grid', () => {
    const relations = ['a', 'b', 'c', 'd'].map((name) => relation(name, [column('id', { isPrimaryKey: true })]));
    const diagram = buildErDiagram({ relations, foreignKeys: [] });
    const positions = layoutErDiagram(diagram);
    assert.equal(Object.keys(positions).length, 4);
    for (const position of Object.values(positions)) {
      assert.ok(position.x >= ERD_MARGIN);
      assert.ok(position.y >= ERD_MARGIN);
    }
    // A 2x2 grid: two distinct rows, two distinct columns.
    const rows = new Set(Object.values(positions).map((position) => position.y));
    assert.equal(rows.size, 2);
  });

  it('handles an empty diagram', () => {
    assert.deepEqual(layoutErDiagram({ tables: [], relationships: [] }), {});
  });
});
