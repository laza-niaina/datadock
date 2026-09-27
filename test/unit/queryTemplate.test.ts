import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { qualifiedRelationName, quoteIdentifier, selectStatementFor } from '../../src/sql/queryTemplate';

describe('quoteIdentifier', () => {
  it('uses backticks on MySQL and MariaDB', () => {
    assert.equal(quoteIdentifier('users', 'mysql'), '`users`');
    assert.equal(quoteIdentifier('users', 'mariadb'), '`users`');
  });

  it('uses ANSI double quotes on PostgreSQL, SQL Server and SQLite', () => {
    assert.equal(quoteIdentifier('users', 'postgresql'), '"users"');
    assert.equal(quoteIdentifier('users', 'mssql'), '"users"');
    assert.equal(quoteIdentifier('users', 'sqlite'), '"users"');
  });

  it('escapes the quote character of the dialect it used', () => {
    assert.equal(quoteIdentifier('we`ird', 'mysql'), '`we``ird`');
    assert.equal(quoteIdentifier('we"ird', 'postgresql'), '"we""ird"');
  });
});

describe('qualifiedRelationName', () => {
  it('keeps the schema when the engine has one', () => {
    assert.equal(qualifiedRelationName({ schema: 'public', table: 'users' }, 'postgresql'), '"public"."users"');
  });

  it('omits the schema when the node has none', () => {
    assert.equal(qualifiedRelationName({ table: 'users' }, 'mysql'), '`users`');
  });
});

describe('selectStatementFor', () => {
  it('builds a read-only scaffold with a context comment', () => {
    assert.equal(
      selectStatementFor({ table: 'users' }, 'mysql'),
      ['-- DataDock: mysql', 'SELECT *', 'FROM `users`;'].join('\n'),
    );
  });

  it('mentions the database in the comment but never injects a USE', () => {
    const sql = selectStatementFor({ database: 'shop', table: 'orders' }, 'postgresql');
    assert.equal(sql, ['-- DataDock: postgresql · shop', 'SELECT *', 'FROM "orders";'].join('\n'));
    assert.ok(!/^\s*USE\s/im.test(sql));
  });

  it('quotes schema and table together for PostgreSQL', () => {
    assert.equal(
      selectStatementFor({ database: 'shop', schema: 'billing', table: 'invoices' }, 'postgresql'),
      ['-- DataDock: postgresql · shop', 'SELECT *', 'FROM "billing"."invoices";'].join('\n'),
    );
  });

  it('never appends a LIMIT, so the executed text is what the user sees', () => {
    assert.ok(!/LIMIT/i.test(selectStatementFor({ table: 'users' }, 'mssql')));
  });
});
