import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitSqlStatements, statementAtOffset } from '../../src/sql/sqlStatements';

function texts(sql: string, engine: Parameters<typeof splitSqlStatements>[1] = 'mysql'): string[] {
  return splitSqlStatements(sql, engine).map((statement) => statement.text);
}

describe('SQL statement splitting', () => {
  it('splits plain semicolon-separated statements', () => {
    assert.deepEqual(texts('SELECT 1; SELECT 2;'), ['SELECT 1', 'SELECT 2']);
    assert.deepEqual(texts('SELECT 1'), ['SELECT 1']);
    assert.deepEqual(texts('   '), []);
    assert.deepEqual(texts('; ;'), []);
  });

  it('keeps semicolons inside string literals', () => {
    assert.deepEqual(texts("SELECT 'a;b' AS value; SELECT 2;"), ["SELECT 'a;b' AS value", 'SELECT 2']);
    assert.deepEqual(texts('SELECT "a;b";'), ['SELECT "a;b"']);
  });

  it('keeps semicolons inside doubled and backslash-escaped quotes', () => {
    assert.deepEqual(texts("SELECT 'it''s; fine'; SELECT 2;"), ["SELECT 'it''s; fine'", 'SELECT 2']);
    assert.deepEqual(texts("SELECT 'it\\'s; fine'; SELECT 2;"), ["SELECT 'it\\'s; fine'", 'SELECT 2']);
    assert.deepEqual(texts('SELECT `col;name` FROM t; SELECT 2;'), ['SELECT `col;name` FROM t', 'SELECT 2']);
    assert.deepEqual(texts('SELECT `a``b;c`;'), ['SELECT `a``b;c`']);
  });

  it('ignores semicolons inside comments', () => {
    assert.deepEqual(texts('-- first; comment\nSELECT 1;'), ['SELECT 1']);
    assert.deepEqual(texts('SELECT 1; /* block; comment */ SELECT 2;'), ['SELECT 1', 'SELECT 2']);
    assert.deepEqual(texts('SELECT 1 /* mid; statement */ ; SELECT 2;'), ['SELECT 1 /* mid; statement */', 'SELECT 2']);
  });

  it('handles hash comments on MySQL but not on SQLite', () => {
    assert.deepEqual(texts('# drop; me\nSELECT 1;', 'mysql'), ['SELECT 1']);
    assert.deepEqual(texts('# not a comment\nSELECT 1;', 'sqlite'), ['# not a comment\nSELECT 1']);
  });

  it('keeps a statement inside a block comment intact across the whole script', () => {
    assert.deepEqual(texts('/* SELECT 1; SELECT 2; */ SELECT 3;'), ['SELECT 3']);
  });

  it('splits SQLite bracket-quoted identifiers', () => {
    assert.deepEqual(texts('SELECT [odd; name] FROM t; SELECT 2;', 'sqlite'), ['SELECT [odd; name] FROM t', 'SELECT 2']);
  });

  it('keeps BEGIN...END bodies together with a custom MySQL delimiter', () => {
    const sql = `DELIMITER //
CREATE PROCEDURE p()
BEGIN
  SELECT 1;
  SELECT 2;
END//
DELIMITER ;
SELECT 3;`;
    assert.deepEqual(texts(sql, 'mysql'), [
      'CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND',
      'SELECT 3',
    ]);
  });

  it('handles a dollar-style custom delimiter and resets it', () => {
    const sql = `DELIMITER $$
CREATE FUNCTION f() RETURNS INT
BEGIN
  RETURN 1;
END$$
DELIMITER ;
SELECT f();`;
    assert.deepEqual(texts(sql, 'mysql'), [
      'CREATE FUNCTION f() RETURNS INT\nBEGIN\n  RETURN 1;\nEND',
      'SELECT f()',
    ]);
  });

  it('reports accurate offsets for reveal-in-file navigation', () => {
    const sql = '  SELECT 1;\n\nSELECT 2;\n';
    const statements = splitSqlStatements(sql);
    assert.deepEqual(
      statements.map((statement) => ({ start: statement.start, end: statement.end, text: statement.text })),
      [
        { start: 2, end: 10, text: 'SELECT 1' },
        { start: 13, end: 21, text: 'SELECT 2' },
      ],
    );
  });

  it('does not confuse an unterminated string with the rest of the file', () => {
    assert.deepEqual(texts("SELECT 'oops;"), ["SELECT 'oops;"]);
  });

  it('ignores multiple DELIMITER lines and comment lines before the first statement', () => {
    const sql = `-- routine below
DELIMITER //
CREATE PROCEDURE p()
BEGIN
  SELECT 1;
END//
DELIMITER ;`;
    assert.deepEqual(texts(sql, 'mysql'), ['CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND']);
  });

  it('picks the statement under the cursor', () => {
    const statements = splitSqlStatements('SELECT 1;\nSELECT 2;\nSELECT 3;');
    assert.equal(statementAtOffset(statements, 0)?.text, 'SELECT 1');
    assert.equal(statementAtOffset(statements, 8)?.text, 'SELECT 1');
    assert.equal(statementAtOffset(statements, 10)?.text, 'SELECT 2');
    assert.equal(statementAtOffset(statements, 11)?.text, 'SELECT 2');
    assert.equal(statementAtOffset(statements, 20)?.text, 'SELECT 3');
    assert.equal(statementAtOffset(statements, 25)?.text, 'SELECT 3');
    assert.equal(statementAtOffset(statements, 999)?.text, 'SELECT 3');
    assert.equal(statementAtOffset([], 0), undefined);
  });

  it('prefers the next statement when the cursor sits in blank space', () => {
    const statements = splitSqlStatements('SELECT 1;\n\n\nSELECT 2;');
    assert.equal(statementAtOffset(statements, 10)?.text, 'SELECT 2');
  });

  it('splits consecutive semicolon-terminated statements with no blank line between them', () => {
    const sql = `INSERT INTO categories (
    title
) VALUES ("Dessert"), ("Boisson"), ("Entree");
INSERT INTO ingredients (title)
VALUES ("farine"), ("oeuf"), ("citron"), ("sucre"), ("lait"), ("frommage");`;
    assert.deepEqual(texts(sql), [
      'INSERT INTO categories (\n    title\n) VALUES ("Dessert"), ("Boisson"), ("Entree")',
      'INSERT INTO ingredients (title)\nVALUES ("farine"), ("oeuf"), ("citron"), ("sucre"), ("lait"), ("frommage")',
    ]);
    assert.deepEqual(texts('SELECT 1;SELECT 2;'), ['SELECT 1', 'SELECT 2']);
  });

  it('splits statements on a blank line when no semicolon is used', () => {
    const sql = `INSERT INTO categories (
    title
) VALUES ("Dessert"), ("Boisson"), ("Entree")

INSERT INTO ingredients (title)
VALUES ("farine"), ("oeuf"), ("citron"), ("sucre"), ("lait"), ("frommage")`;
    assert.deepEqual(texts(sql), [
      'INSERT INTO categories (\n    title\n) VALUES ("Dessert"), ("Boisson"), ("Entree")',
      'INSERT INTO ingredients (title)\nVALUES ("farine"), ("oeuf"), ("citron"), ("sucre"), ("lait"), ("frommage")',
    ]);
  });

  it('does not split on a plain line break when no semicolon is used', () => {
    const sql = `INSERT INTO categories (
    title
) VALUES ("Dessert"), ("Boisson"), ("Entree")
INSERT INTO ingredients (title)
VALUES ("farine"), ("oeuf")`;
    assert.deepEqual(texts(sql), [sql]);
  });

  it('ignores semicolons inside strings before splitting adjacent statements', () => {
    const sql = `INSERT INTO messages (content)
VALUES ("Bonjour; ceci contient un point-virgule");
INSERT INTO users (name)
VALUES ("Laza");`;
    assert.deepEqual(texts(sql), [
      'INSERT INTO messages (content)\nVALUES ("Bonjour; ceci contient un point-virgule")',
      'INSERT INTO users (name)\nVALUES ("Laza")',
    ]);
  });

  it('treats a whitespace-only line as a blank line separator', () => {
    assert.deepEqual(texts('SELECT 1\n   \t \nSELECT 2'), ['SELECT 1', 'SELECT 2']);
  });

  it('collapses several blank lines into one separator', () => {
    assert.deepEqual(texts('SELECT 1\n\n\n\nSELECT 2'), ['SELECT 1', 'SELECT 2']);
  });

  it('ignores leading and trailing blank lines', () => {
    assert.deepEqual(texts('\n\nSELECT 1\n\n\n'), ['SELECT 1']);
  });

  it('splits after a trailing comment line before a blank line', () => {
    const sql = `SELECT 1
-- trailing note

SELECT 2`;
    assert.deepEqual(texts(sql), ['SELECT 1\n-- trailing note', 'SELECT 2']);
  });

  it('keeps blank lines inside a DELIMITER routine body', () => {
    const sql = `DELIMITER //
CREATE PROCEDURE p()
BEGIN
  SELECT 1;

  SELECT 2;
END//
DELIMITER ;
SELECT 3;`;
    assert.deepEqual(texts(sql, 'mysql'), [
      'CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n\n  SELECT 2;\nEND',
      'SELECT 3',
    ]);
  });
});