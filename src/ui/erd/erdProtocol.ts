/**
 * Wire protocol between the ER diagram panel (extension host) and its webview.
 *
 * Shared by both sides so neither can drift: the host narrows untrusted
 * webview JSON into `ErAppMessage` before acting on it, and the webview treats
 * everything in `ErHostMessage` as data, never as instructions. Nothing here
 * carries credentials, SQL or connection options.
 */

import { DbError } from '../../db/errors';
import type { ErPosition } from './erdLayout';
import type { ErDiagram } from './erdModel';

/** Static identity of one ER diagram tab, injected by the page shell. */
export interface ErIsland {
  /** Label of the scope, e.g. the database name. */
  title: string;
  connectionName: string;
  database?: string;
}

/** Everything the webview needs to draw one diagram. */
export interface ErDiagramPayload {
  /** Every schema of the connection (empty when the engine has no schemas). */
  schemas: string[];
  /** Schemas currently loaded; empty when the engine has no schema selector. */
  selected: string[];
  diagram: ErDiagram;
  /** Saved box positions, keyed by schema-qualified table id. */
  positions: Record<string, ErPosition>;
}

/** Host → webview. */
export type ErHostMessage =
  | ({ type: 'diagram' } & ErDiagramPayload)
  | { type: 'error'; message: string };

/** Webview → host. */
export type ErAppMessage =
  | { type: 'ready' }
  | { type: 'reload' }
  | { type: 'select'; schemas: string[] }
  /** `null` forgets the stored positions of this diagram. */
  | { type: 'positions'; positions: Record<string, ErPosition> | null };

// --- narrowing -----------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrows the untrusted webview payload before any of it is acted upon.
 *
 * Anything that is not one of the four shapes above (or that carries a
 * non-finite coordinate) is dropped: the host only ever reacts to a schema
 * selection, a position map or a reload request.
 */
export function parseAppMessage(raw: unknown): ErAppMessage | undefined {
  if (!isRecord(raw) || typeof raw.type !== 'string') {
    return undefined;
  }
  if (raw.type === 'ready') {
    return { type: 'ready' };
  }
  if (raw.type === 'reload') {
    return { type: 'reload' };
  }
  if (raw.type === 'select' && Array.isArray(raw.schemas)) {
    const schemas = raw.schemas.filter((item): item is string => typeof item === 'string');
    return { type: 'select', schemas };
  }
  if (raw.type === 'positions') {
    if (raw.positions === null) {
      return { type: 'positions', positions: null };
    }
    if (!isRecord(raw.positions)) {
      return undefined;
    }
    const positions: Record<string, ErPosition> = {};
    for (const [id, point] of Object.entries(raw.positions)) {
      if (
        isRecord(point) &&
        typeof point.x === 'number' &&
        typeof point.y === 'number' &&
        Number.isFinite(point.x) &&
        Number.isFinite(point.y)
      ) {
        positions[id] = { x: point.x, y: point.y };
      }
    }
    return { type: 'positions', positions };
  }
  return undefined;
}

/** Turns a driver error into a sentence a person can act on. */
export function describeErError(error: unknown): string {
  if (error instanceof DbError) {
    switch (error.code) {
      case 'CONNECTION_LOST':
      case 'CONNECTION_REFUSED':
      case 'AUTH_FAILED':
      case 'PERMISSION_DENIED':
      case 'DRIVER_NOT_FOUND':
        return 'The connection is not usable any more. Reconnect it in DB Explorer, then reopen the diagram.';
      case 'CONFIG_ERROR':
        return 'This connection has no database or schema selected.';
      default:
        return error.message;
    }
  }
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message;
  }
  return 'The diagram could not be loaded.';
}

