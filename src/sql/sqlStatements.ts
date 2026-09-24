/**
 * SQL statement splitting without a naive `split(";")`.
 *
 * A plain `split(";")` breaks on semicolons that live inside string literals,
 * quoted identifiers, comments or `BEGIN ... END` bodies. This module walks the
 * source like a small lexer so each engine gets statements it can actually
 * execute on a single-statement connection (`multipleStatements:false` on
 * MySQL, `db.exec` batches on SQLite).
 *
 * Deliberately free of any `vscode` import: the cursor helpers below are used
 * by the editor commands, but the lexer itself is pure so it can be unit
 * tested with `node --test`.
 */

import type { EngineId } from '../db/types';

/** One executable statement, with offsets expressed in the source text. */
export interface SqlStatement {
  /** Trimmed statement text, without the trailing delimiter or surrounding trivia. */
  readonly text: string;
  /** Offset of the first significant character in the source text. */
  readonly start: number;
  /** Offset just past the last significant character (delimiter excluded). */
  readonly end: number;
}

type SqlEngine = EngineId;

function isMysqlFamily(engine: SqlEngine): boolean {
  return engine === 'mysql' || engine === 'mariadb';
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n' || char === '\f' || char === '\v';
}

/**
 * Splits `sql` into statements.
 *
 * Details handled here:
 *  - single quotes, double quotes and backticks, with doubled-quote escapes and
 *    (for string literals) backslash escapes;
 *  - `[...]` quoted identifiers for engines that accept them (SQLite);
 *  - `--` line comments everywhere, `#` line comments for MySQL/MariaDB and
 *    block comments between `/*` and `star-slash` (semicolons and delimiters
 *    inside are ignored);
 *  - the MySQL `DELIMITER` directive so routines and functions containing
 *    semicolons stay one statement;
 *  - a semicolon outside a string/comment ends the statement immediately, even
 *    when the next statement follows on the same line;
 *  - a blank line separates two statements that were not ended with a
 *    semicolon (a plain line break never does); the rule is suspended while a
 *    custom `DELIMITER` is active so routine bodies keep their blank lines.
 */
export function splitSqlStatements(sql: string, engine: SqlEngine = 'mysql'): SqlStatement[] {
  const statements: SqlStatement[] = [];
  const length = sql.length;
  const mysql = isMysqlFamily(engine);

  let cursor = 0;
  let delimiter = ';';
  let textStart = -1;

  const beginStatement = (offset: number): void => {
    if (textStart === -1) {
      textStart = offset;
    }
  };

  const atLineStart = (offset: number): boolean =>
    offset === 0 || sql.charCodeAt(offset - 1) === 10 /* \n */ || sql.charCodeAt(offset - 1) === 13 /* \r */;

  /**
   * Whether the line terminator at `offset` is followed by a blank line, i.e.
   * only whitespace up to (and including) a second line terminator. Used for
   * the "blank line separates statements when no semicolon is used" rule.
   */
  const hasBlankLineAfter = (offset: number): boolean => {
    let pos = offset;
    const first = sql.charCodeAt(pos);
    pos += first === 13 /* \r */ && sql.charCodeAt(pos + 1) === 10 /* \n */ ? 2 : 1;
    let sawSecondNewline = false;
    while (pos < length) {
      const code = sql.charCodeAt(pos);
      if (code === 32 || code === 9 || code === 12 || code === 11) {
        pos += 1;
        continue;
      }
      if (code === 10 || code === 13) {
        sawSecondNewline = true;
        pos += code === 13 && sql.charCodeAt(pos + 1) === 10 ? 2 : 1;
        continue;
      }
      break;
    }
    return sawSecondNewline;
  };

  /** Consumes a line comment up to (not including) the end of the line. */
  const consumeLineComment = (offset: number): number => {
    let pos = offset;
    while (pos < length && sql.charCodeAt(pos) !== 10 && sql.charCodeAt(pos) !== 13) {
      pos += 1;
    }
    return pos;
  };

  /** Consumes a block comment between `/*` and `star-slash`; an unterminated block runs to the end. */
  const consumeBlockComment = (offset: number): number => {
    const close = sql.indexOf('*/', offset + 2);
    return close === -1 ? length : close + 2;
  };

  /** Consumes one quoted string / quoted identifier, returning the position past it. */
  const consumeQuoted = (offset: number, quote: string): number => {
    let pos = offset + 1;
    while (pos < length) {
      const char = sql[pos];
      if (char === '\\' && quote !== '`') {
        pos += 2;
        continue;
      }
      if (char === quote) {
        if (sql[pos + 1] === quote) {
          pos += 2;
          continue;
        }
        return pos + 1;
      }
      pos += 1;
    }
    return length;
  };

  /** Consumes a `[...]` quoted identifier, returning the position past it. */
  const consumeBracket = (offset: number): number => {
    let pos = offset + 1;
    while (pos < length) {
      if (sql[pos] === ']') {
        if (sql[pos + 1] === ']') {
          pos += 2;
          continue;
        }
        return pos + 1;
      }
      pos += 1;
    }
    return length;
  };

  /**
   * When the cursor sits at the start of a statement region and the line begins
   * with `DELIMITER <token>`, switches the active delimiter and returns the
   * offset right after the directive line.
   */
  const tryDelimiter = (offset: number): number | undefined => {
    if (textStart !== -1 || !atLineStart(offset) || !mysql) {
      return undefined;
    }
    const rest = sql.slice(offset);
    if (!/^DELIMITER\b/i.test(rest)) {
      return undefined;
    }
    const lineEnd = rest.search(/[\r\n]/);
    const line = lineEnd === -1 ? rest : rest.slice(0, lineEnd);
    const withoutComment = line.replace(/\s+--.*$/i, '');
    const parts = withoutComment.trim().split(/\s+/);
    if (parts.length < 2) {
      return undefined;
    }
    delimiter = parts[1];
    return offset + line.length;
  };

  const pushStatement = (endOffset: number): void => {
    if (textStart === -1) {
      return;
    }
    const trimmed = sql.slice(textStart, endOffset).replace(/\s+$/, '');
    if (trimmed.length > 0) {
      statements.push({ text: trimmed, start: textStart, end: textStart + trimmed.length });
    }
    textStart = -1;
  };

  while (cursor < length) {
    const char = sql[cursor];
    const next = sql[cursor + 1];

    const afterDelimiter = tryDelimiter(cursor);
    if (afterDelimiter !== undefined) {
      cursor = afterDelimiter;
      continue;
    }

    if (char === '-' && next === '-') {
      cursor = consumeLineComment(cursor + 2);
      continue;
    }
    if (mysql && char === '#') {
      cursor = consumeLineComment(cursor + 1);
      continue;
    }
    if (char === '/' && next === '*') {
      cursor = consumeBlockComment(cursor);
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      beginStatement(cursor);
      cursor = consumeQuoted(cursor, char);
      continue;
    }
    if (char === '[' && !mysql) {
      beginStatement(cursor);
      cursor = consumeBracket(cursor);
      continue;
    }
    if (delimiter.length > 0 && sql.startsWith(delimiter, cursor)) {
      pushStatement(cursor);
      cursor += delimiter.length;
      continue;
    }
    if (isWhitespace(char)) {
      // Blank line as a separator: when statements are not terminated with a
      // semicolon, an empty line ends the current block. A plain line break
      // never separates two statements. The rule is disabled while a custom
      // DELIMITER is active (routine bodies keep their internal blank lines).
      if (textStart !== -1 && delimiter === ';' && (char === '\n' || char === '\r') && hasBlankLineAfter(cursor)) {
        pushStatement(cursor);
      }
      cursor += 1;
      continue;
    }
    beginStatement(cursor);
    cursor += 1;
  }

  pushStatement(length);
  return statements;
}

/**
 * Returns the statement the editor cursor should run.
 *
 * When the offset sits inside a statement, that statement wins. When it sits in
 * the blank/comment area between two statements, the statement that starts at
 * or after the offset wins (so Enter on an empty line runs the next query).
 */
export function statementAtOffset(statements: readonly SqlStatement[], offset: number): SqlStatement | undefined {
  if (statements.length === 0) {
    return undefined;
  }
  const first = statements[0];
  if (offset < first.start) {
    return first;
  }
  for (const statement of statements) {
    if (offset >= statement.start && offset <= statement.end) {
      return statement;
    }
    if (statement.start > offset) {
      break;
    }
  }
  const next = statements.find((statement) => statement.start >= offset);
  return next ?? statements[statements.length - 1];
}
