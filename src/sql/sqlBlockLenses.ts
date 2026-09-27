/**
 * Pure builder for the CodeLens shown above each SQL block.
 *
 * The provider in `sqlCodeLens.ts` only maps these descriptors onto
 * `vscode.CodeLens` instances; everything that can be tested without the
 * extension host lives here so `node --test` can lock the behaviour.
 */

import { sqlStatusLabels } from '../util/engineDisplay';
import type { EngineId } from '../db/types';

/** Connection facts a block lens renders, when the file is associated. */
export interface SqlBlockLensInfo {
  /** Profile name shown next to the database icon; absent means "Connect". */
  readonly connectionName?: string;
  readonly engine?: EngineId;
  /** Effective active database for the file (association override or profile default). */
  readonly database?: string;
}

/** One SQL block the lenses attach to. */
export interface SqlBlockInput {
  /** 0-based line of the first significant character of the block. */
  readonly line: number;
  /** Character offset of the block start in the document. */
  readonly start: number;
  /** Character offset just past the block end. */
  readonly end: number;
}

/** A CodeLens in descriptor form, ready to map onto VS Code types. */
export interface SqlBlockLensDescriptor {
  readonly line: number;
  readonly title: string;
  readonly command: string;
  readonly arguments: unknown[];
}

export interface SqlBlockLensOptions {
  /** Used as the first command argument of the per-block run command. */
  readonly uri: string;
}

/**
 * Builds the lens bar of a SQL document.
 *
 *  - **Per block**: "Run selected query" runs exactly that statement, from the
 *    same offsets `Ctrl+Enter` resolves through the shared splitter.
 *  - **Per document** (first block only): "Run all queries", the connection and
 *    the engine + active database. Repeating them above every statement filled
 *    the editor with identical buttons, so they are emitted once.
 *
 * The engine/database lens is only meaningful once a connection exists.
 */
export function buildBlockLensDescriptors(
  blocks: readonly SqlBlockInput[],
  info: SqlBlockLensInfo,
  options: SqlBlockLensOptions,
): SqlBlockLensDescriptor[] {
  const labels = sqlStatusLabels({
    connectionName: info.connectionName,
    engine: info.engine,
    database: info.database,
  });
  const descriptors: SqlBlockLensDescriptor[] = [];
  blocks.forEach((block, index) => {
    if (index === 0) {
      descriptors.push(
        {
          line: block.line,
          title: '$(run-all) Run all queries',
          command: 'dbclient.query.runAll',
          arguments: [],
        },
        {
          line: block.line,
          title: labels.connection,
          command: 'dbclient.query.selectConnection',
          arguments: [options.uri],
        },
      );
      if (labels.database) {
        descriptors.push({
          line: block.line,
          title: labels.database,
          command: 'dbclient.query.selectDatabase',
          arguments: [options.uri],
        });
      }
    }
    descriptors.push({
      line: block.line,
      title: '$(play) Run selected query',
      command: 'dbclient.query.runStatement',
      arguments: [options.uri, block.start, block.end],
    });
  });
  return descriptors;
}