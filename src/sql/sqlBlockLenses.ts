/**
 * Pure builder for the CodeLens shown above each SQL block.
 *
 * The provider in `sqlCodeLens.ts` only maps these descriptors onto
 * `vscode.CodeLens` instances; everything that can be tested without the
 * extension host lives here so `node --test` can lock the behaviour.
 */

import { engineIcon, engineLabel } from '../util/engineDisplay';
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
 * Builds the four lenses requested for each block:
 *  - Run all queries (whole document),
 *  - Run selected query (this block only),
 *  - connection (opens the connection picker; "Connect" when none),
 *  - engine + active database (opens the database picker).
 *
 * The engine/database lens is only meaningful once a connection exists.
 */
export function buildBlockLensDescriptors(
  blocks: readonly SqlBlockInput[],
  info: SqlBlockLensInfo,
  options: SqlBlockLensOptions,
): SqlBlockLensDescriptor[] {
  const descriptors: SqlBlockLensDescriptor[] = [];
  for (const block of blocks) {
    descriptors.push(
      {
        line: block.line,
        title: '$(run-all) Run all queries',
        command: 'dbclient.query.runAll',
        arguments: [],
      },
      {
        line: block.line,
        title: '$(play) Run selected query',
        command: 'dbclient.query.runStatement',
        arguments: [options.uri, block.start, block.end],
      },
      {
        line: block.line,
        title: info.connectionName ? `$(database) ${info.connectionName}` : '$(database) Connect',
        command: 'dbclient.query.selectConnection',
        arguments: [options.uri],
      },
    );
    if (info.connectionName && info.engine) {
      const database = info.database ? `: ${info.database}` : '';
      descriptors.push({
        line: block.line,
        title: `${engineIcon(info.engine)} ${engineLabel(info.engine)}${database}`,
        command: 'dbclient.query.selectDatabase',
        arguments: [options.uri],
      });
    }
  }
  return descriptors;
}