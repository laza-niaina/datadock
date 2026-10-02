import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeWidth,
  fieldsFor,
  widthSignature,
  type Field,
} from '../../src/ui/resultView/gridFields';

describe('fieldsFor', () => {
  it('returns exactly the columns the driver returned', () => {
    const fields = fieldsFor([
      { name: 'id', type: 'int' },
      { name: 'name', type: 'varchar(255)' },
    ]);
    assert.deepEqual(
      fields.map((field) => [field.field, field.name, field.type]),
      [
        ['id', 'id', 'int'],
        ['name', 'name', 'varchar(255)'],
      ],
    );
    // One row per column: no gutter/number column is ever appended.
    assert.equal(fields.length, 2);
  });

  it('keeps columns literally named #, index, row_number or id', () => {
    const names = ['#', 'index', 'row_number', 'id'];
    const fields = fieldsFor(names.map((name) => ({ name, type: 'text' })));
    // These are data like any other column: the name survives as the header,
    // and the row key stays the real column name so cell values still bind.
    assert.deepEqual(
      fields.map((field) => [field.field, field.name]),
      names.map((name) => [name, name]),
    );
    assert.ok(fields.every((field) => field.type === 'text'));
  });

  it('disambiguates duplicate column names without dropping either', () => {
    const fields = fieldsFor([
      { name: 'id', type: 'int' },
      { name: 'id', type: 'int' },
    ]);
    assert.deepEqual(fields.map((field) => field.field), ['id', 'id__1']);
    assert.deepEqual(fields.map((field) => field.name), ['id', 'id']);
  });

  it('handles an empty result shape (a failing statement has no columns)', () => {
    assert.deepEqual(fieldsFor([]), []);
  });

  it('carries the schema key flags without touching the row keys', () => {
    const fields = fieldsFor([
      { name: 'id', type: 'int', primaryKey: true },
      { name: 'org_id', type: 'int', foreignKey: true },
      { name: 'label', type: 'text' },
    ]);
    // The flags are decoration: `field` must still be the plain column name so
    // cell values keep binding after a key mark appears in the header.
    assert.deepEqual(fields.map((field) => field.field), ['id', 'org_id', 'label']);
    assert.deepEqual(
      fields.map((field) => [field.primaryKey === true, field.foreignKey === true]),
      [
        [true, false],
        [false, true],
        [false, false],
      ],
    );
  });
});

describe('computeWidth', () => {
  const field: Field = { field: 'name', name: 'name', type: 'varchar' };

  it('never goes below the floor or above the cap', () => {
    assert.equal(computeWidth(field, [{ name: 'ab' }]), 70);
    assert.equal(
      computeWidth(field, [{ name: 'z'.repeat(500) }]),
      150,
      'one huge TEXT value must not set the column width',
    );
  });

  it('samples only the first loaded rows (auto-fit never reads the table)', () => {
    const rows = Array.from({ length: 200 }, (_value, index) => ({
      name: index < 10 ? 'ab' : 'z'.repeat(60),
    }));
    // Row 11 would force the 150px cap; rows 0-9 give the floor instead.
    assert.equal(computeWidth(field, rows), 70);
  });

  it('reads a column through its row key, not its position', () => {
    const rows = [{ other: 'z'.repeat(60), name: 'ab' }];
    assert.equal(computeWidth(field, rows), 70);
  });

  it('counts the header and the SQL type when no row is loaded yet', () => {
    assert.equal(computeWidth(field, []), 70);
    assert.equal(
      computeWidth({ field: 'amount', name: 'amount', type: 'numeric(19,4)' }, []),
      130,
    );
  });

  it('reserves header room for a column that carries a key mark', () => {
    // The mark sits before the name: a flat pixel reserve applied after the
    // 70px floor, because folding it into the character count would leave a
    // short marked name (`org_id`) exactly where it started - cut off.
    const plain = computeWidth({ field: 'nickname', name: 'nickname' }, []);
    const marked = computeWidth({ field: 'nickname', name: 'nickname', foreignKey: true }, []);
    assert.equal(plain, 80);
    assert.equal(marked, plain + 18);
    // A short name sits on the floor, and the mark still lifts it above it.
    assert.equal(computeWidth({ field: 'id', name: 'id' }, []), 70);
    assert.equal(computeWidth({ field: 'id', name: 'id', primaryKey: true }, []), 88);
    // The case that regressed: `org_id` is 6 characters, so its own estimate
    // (60px) sits under the 70px floor, and the floor alone left the mark with
    // nowhere to stand - the name measured 0.09px over its box and ellipsized.
    assert.equal(
      computeWidth({ field: 'org_id', name: 'org_id', type: 'int', foreignKey: true }, [{ org_id: '1' }]),
      88,
    );
    // Two marks (a column that is both PK and FK) cost the same single slot.
    assert.equal(
      computeWidth({ field: 'nickname', name: 'nickname', primaryKey: true, foreignKey: true }, []),
      marked,
    );
    // The reserve never lifts the ceiling a wide value already reached.
    assert.equal(
      computeWidth({ field: 'nickname', name: 'nickname', primaryKey: true }, [
        { nickname: 'z'.repeat(60) },
      ]),
      150,
    );
  });
});

describe('widthSignature', () => {
  it('is keyed by the table for statement results', () => {
    const signature = widthSignature({
      table: 'users',
      columns: [{ name: 'id', type: 'int' }],
    });
    assert.equal(signature, 'table:users');
    // The columns do not take part: only the table identity decides where
    // widths are stored, so a wider SELECT does not orphan the preference.
    assert.equal(
      widthSignature({ table: 'users', columns: [{ name: 'other' }] }),
      signature,
    );
  });

  it('falls back to the column shape when the statement names no table', () => {
    const signature = widthSignature({
      table: '   ',
      columns: [{ name: 'id' }, { name: 'total' }],
    });
    assert.equal(signature, 'shape:id\u001ftotal');
  });

  it('never carries a statement, a grid id or a cell value', () => {
    // The key lands in `vscode.setState`, i.e. workspace state: it may only
    // ever be a table or column signature. `s1r0` (the old grid id) changed
    // on every re-run, which is why widths used to vanish.
    const signature = widthSignature({
      table: 'users',
      columns: [{ name: 'id', type: 'int' }],
    });
    assert.ok(!/s\d+r\d+/.test(signature));
    assert.ok(!/select|from|where/i.test(signature));
    assert.ok(!signature.includes('int'));
    assert.ok(signature.startsWith('table:'));
  });
});
