import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildErDiagram,
  erDiagramStats,
  erTableId,
  relatedTableIds,
  type ErRelationInput,
} from '../../src/ui/erd/erdModel';
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

function table(name: string, overrides: Partial<TableInfo> = {}): TableInfo {
  return { name, kind: 'table', ...overrides };
}

function relation(
  name: string,
  columns: ColumnInfo[],
  schema?: string,
  tableOverrides: Partial<TableInfo> = {},
): ErRelationInput {
  return { schema, table: table(name, tableOverrides), columns };
}

const shop: ErRelationInput[] = [
  relation('users', [column('id', { isPrimaryKey: true, isAutoIncrement: true }), column('email')]),
  relation('orders', [
    column('id', { isPrimaryKey: true, isAutoIncrement: true }),
    column('user_id', { ordinal: 2 }),
    column('total', { ordinal: 3 }),
  ]),
  relation('products', [column('id', { isPrimaryKey: true, isAutoIncrement: true }), column('sku')]),
  relation('order_items', [
    column('id', { isPrimaryKey: true, isAutoIncrement: true }),
    column('order_id', { ordinal: 2 }),
    column('product_id', { ordinal: 3 }),
    column('quantity', { ordinal: 4 }),
  ]),
];

const shopKeys: ForeignKeyInfo[] = [
  { name: 'fk_order_items_order', sourceTable: 'order_items', sourceColumn: 'order_id', targetTable: 'orders', targetColumn: 'id', ordinal: 1 },
  { name: 'fk_order_items_product', sourceTable: 'order_items', sourceColumn: 'product_id', targetTable: 'products', targetColumn: 'id', ordinal: 1 },
  { name: 'fk_orders_user', sourceTable: 'orders', sourceColumn: 'user_id', targetTable: 'users', targetColumn: 'id', ordinal: 1 },
];

describe('erTableId', () => {
  it('qualifies with the schema only when there is one', () => {
    assert.equal(erTableId(undefined, 'orders'), 'orders');
    assert.equal(erTableId('', 'orders'), 'orders');
    assert.equal(erTableId('public', 'orders'), 'public.orders');
    assert.equal(erTableId('  public  ', 'orders'), 'public.orders');
  });
});

describe('buildErDiagram', () => {
  it('sorts tables and relationships so two renders of the same data match', () => {
    const forward = buildErDiagram({ relations: shop, foreignKeys: shopKeys });
    const reversed = buildErDiagram({ relations: [...shop].reverse(), foreignKeys: [...shopKeys].reverse() });
    assert.deepEqual(
      forward.tables.map((item) => item.id),
      ['order_items', 'orders', 'products', 'users'],
    );
    assert.deepEqual(forward.tables.map((item) => item.id), reversed.tables.map((item) => item.id));
    assert.deepEqual(forward.relationships.map((item) => item.id), reversed.relationships.map((item) => item.id));
  });

  it('produces one relationship per column pair of the engine-declared constraints', () => {
    const diagram = buildErDiagram({ relations: shop, foreignKeys: shopKeys });
    assert.deepEqual(diagram.relationships.map((item) => [item.sourceTableId, item.sourceColumn, item.targetTableId, item.targetColumn]), [
      ['order_items', 'order_id', 'orders', 'id'],
      ['order_items', 'product_id', 'products', 'id'],
      ['orders', 'user_id', 'users', 'id'],
    ]);
    assert.deepEqual(diagram.relationships.map((item) => item.constraintName), [
      'fk_order_items_order',
      'fk_order_items_product',
      'fk_orders_user',
    ]);
  });

  it('never draws a line whose endpoints were not loaded', () => {
    const withoutUsers = shop.filter((item) => item.table.name !== 'users');
    const diagram = buildErDiagram({ relations: withoutUsers, foreignKeys: shopKeys });
    assert.deepEqual(diagram.relationships.map((item) => item.id), [
      'fk_order_items_order:order_items:order_id->orders:id',
      'fk_order_items_product:order_items:product_id->products:id',
    ]);
    // Nothing points at a box that does not exist.
    const ids = new Set(diagram.tables.map((item) => item.id));
    for (const relationship of diagram.relationships) {
      assert.equal(ids.has(relationship.sourceTableId), true);
      assert.equal(ids.has(relationship.targetTableId), true);
    }
  });

  it('drops a foreign key whose source column is not in the loaded columns', () => {
    const diagram = buildErDiagram({
      relations: shop.map((item) =>
        item.table.name === 'orders'
          ? { ...item, columns: item.columns.filter((col) => col.name !== 'user_id') }
          : item,
      ),
      foreignKeys: shopKeys,
    });
    assert.deepEqual(
      diagram.relationships.map((item) => item.sourceTableId),
      ['order_items', 'order_items'],
    );
  });

  it('resolves an unnamed referenced column to the target single primary key', () => {
    const keys: ForeignKeyInfo[] = [
      // SQLite reports `targetColumn: undefined` for a constraint pointing at
      // the parent's implicit primary key.
      { sourceTable: 'orders', sourceColumn: 'user_id', targetTable: 'users', ordinal: 1 },
      // A target without any primary key stays unresolved (header anchor).
      { sourceTable: 'orders', sourceColumn: 'total', targetTable: 'audit', ordinal: 1 },
    ];
    const relations = [
      ...shop,
      relation('audit', [column('note')]),
    ];
    const diagram = buildErDiagram({ relations, foreignKeys: keys });
    assert.deepEqual(diagram.relationships.map((item) => [item.sourceColumn, item.targetColumn]), [
      ['total', undefined],
      ['user_id', 'id'],
    ]);
  });

  it('keeps same-named tables of different schemas apart and matches constraints by schema', () => {
    const relations = [
      relation('orders', [column('id', { isPrimaryKey: true }), column('user_id', { ordinal: 2 })], 'shop'),
      relation('orders', [column('id', { isPrimaryKey: true }), column('user_id', { ordinal: 2 })], 'billing'),
      relation('users', [column('id', { isPrimaryKey: true })], 'shop'),
      relation('users', [column('id', { isPrimaryKey: true })], 'billing'),
    ];
    const keys: ForeignKeyInfo[] = [
      { name: 'shop_fk', sourceSchema: 'shop', sourceTable: 'orders', sourceColumn: 'user_id', targetSchema: 'shop', targetTable: 'users', targetColumn: 'id', ordinal: 1 },
      { name: 'billing_fk', sourceSchema: 'billing', sourceTable: 'orders', sourceColumn: 'user_id', targetSchema: 'billing', targetTable: 'users', targetColumn: 'id', ordinal: 1 },
      // Points at a schema that was never selected: no line.
      { name: 'ghost_fk', sourceSchema: 'shop', sourceTable: 'orders', sourceColumn: 'id', targetSchema: 'other', targetTable: 'users', targetColumn: 'id', ordinal: 1 },
    ];
    const diagram = buildErDiagram({ relations, foreignKeys: keys });
    assert.deepEqual(
      diagram.relationships.map((item) => [item.id, item.sourceTableId, item.targetTableId]),
      [
        ['billing_fk:billing.orders:user_id->billing.users:id', 'billing.orders', 'billing.users'],
        ['shop_fk:shop.orders:user_id->shop.users:id', 'shop.orders', 'shop.users'],
      ],
    );
  });

  it('marks the referencing columns as foreign keys even without a driver flag', () => {
    const relations = shop.map((item) => ({
      ...item,
      columns: item.columns.map((col) => ({ ...col, isForeignKey: false })),
    }));
    const diagram = buildErDiagram({ relations, foreignKeys: shopKeys });
    const orders = diagram.tables.find((item) => item.id === 'orders');
    assert.deepEqual(
      orders?.columns.filter((col) => col.isForeignKey).map((col) => col.name),
      ['user_id'],
    );
  });

  it('keeps composite constraints apart through their ordinal', () => {
    const relations = [
      relation('orders', [column('id', { isPrimaryKey: true }), column('org_id', { ordinal: 2 }), column('seq', { ordinal: 3 })]),
      relation('orgs', [column('a', { isPrimaryKey: true }), column('b', { isPrimaryKey: true })]),
    ];
    const keys: ForeignKeyInfo[] = [
      { name: 'fk_composite', sourceTable: 'orders', sourceColumn: 'org_id', targetTable: 'orgs', targetColumn: 'a', ordinal: 1 },
      { name: 'fk_composite', sourceTable: 'orders', sourceColumn: 'seq', targetTable: 'orgs', targetColumn: 'b', ordinal: 2 },
    ];
    const diagram = buildErDiagram({ relations, foreignKeys: keys });
    assert.deepEqual(diagram.relationships.map((item) => [item.ordinal, item.sourceColumn, item.targetColumn]), [
      [1, 'org_id', 'a'],
      [2, 'seq', 'b'],
    ]);
  });

  it('gives views a box too, tagged as views', () => {
    const diagram = buildErDiagram({
      relations: [relation('v_users', [column('id')], undefined, { kind: 'view' })],
      foreignKeys: [],
    });
    assert.equal(diagram.tables[0].kind, 'view');
  });

  it('reports stats for the toolbar', () => {
    const diagram = buildErDiagram({ relations: shop, foreignKeys: shopKeys });
    assert.deepEqual(erDiagramStats(diagram), { tables: 4, relationships: 3 });
    assert.deepEqual([...relatedTableIds(diagram)].sort(), ['order_items', 'orders', 'products', 'users']);
  });

  it('handles an empty input without throwing', () => {
    const diagram = buildErDiagram({ relations: [], foreignKeys: [] });
    assert.deepEqual(diagram, { tables: [], relationships: [] });
    assert.deepEqual([...relatedTableIds(diagram)], []);
  });
});
