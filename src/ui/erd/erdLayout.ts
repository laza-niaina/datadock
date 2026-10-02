/**
 * Automatic ER diagram layout.
 *
 * Uses **dagre** (MIT, 0.8.5): a graph layout library that is pure JavaScript
 * with no DOM dependency, so it runs inside a VS Code webview bundle exactly
 * like it runs under `node --test`.
 *
 * The pass is split in two, mirroring how the reference DBCode diagram reads:
 *
 *  - tables taking part in at least one relationship are laid out by dagre
 *    left-to-right (the referencing table ends up on the left, the referenced
 *    table on the right);
 *  - tables without any relationship are placed in a compact grid **below**
 *    that block instead of being fed to the layout engine, which would give
 *    them meaningless ranks.
 *
 * Coordinates are top-left of each box in world pixels, normalised so the
 * whole diagram starts at `ERD_MARGIN` on both axes. The function is pure and
 * deterministic: same diagram, same positions.
 */

import { graphlib, layout } from 'dagre';
import { relatedTableIds, type ErDiagram, type ErTable } from './erdModel';

/** Box width of every table (columns are ellipsised in the webview). */
export const ERD_TABLE_WIDTH = 240;
/** Height of the box header that carries the table name. */
export const ERD_HEADER_HEIGHT = 32;
/** Height of one column row. */
export const ERD_ROW_HEIGHT = 24;
/** Distance kept around the whole diagram. */
export const ERD_MARGIN = 48;
/** Horizontal gap between two boxes of the isolated grid. */
export const ERD_GAP = 48;
/** Extra vertical distance between the related block and the isolated grid. */
export const ERD_ISOLATED_GAP = 96;

export interface ErPosition {
  x: number;
  y: number;
}

export interface ErLayoutOptions {
  /** Box width; defaults to `ERD_TABLE_WIDTH`. */
  tableWidth?: number;
}

/** Height a box needs for `columnCount` columns. */
export function erTableHeight(columnCount: number): number {
  return ERD_HEADER_HEIGHT + Math.max(1, columnCount) * ERD_ROW_HEIGHT;
}

/** Size a box needs for `columnCount` columns. */
export function erTableSize(columnCount: number): { width: number; height: number } {
  return { width: ERD_TABLE_WIDTH, height: erTableHeight(columnCount) };
}

/**
 * Computes a position for every table of `diagram`.
 *
 * The returned map always covers `diagram.tables` - never more, never less -
 * so the renderer can look a table up without checking.
 */
export function layoutErDiagram(
  diagram: ErDiagram,
  options: ErLayoutOptions = {},
): Record<string, ErPosition> {
  const width = options.tableWidth ?? ERD_TABLE_WIDTH;
  const positions: Record<string, ErPosition> = {};
  const related = relatedTableIds(diagram);
  const connected = diagram.tables.filter((table) => related.has(table.id));
  const isolated = diagram.tables.filter((table) => !related.has(table.id));

  let nextRowTop = ERD_MARGIN;

  if (connected.length > 0) {
    const graph = new graphlib.Graph({ directed: true });
    graph.setGraph({
      rankdir: 'LR',
      nodesep: ERD_GAP,
      ranksep: ERD_GAP * 2,
      marginx: ERD_MARGIN,
      marginy: ERD_MARGIN,
    });
    graph.setDefaultEdgeLabel(() => ({}));

    for (const table of connected) {
      graph.setNode(table.id, { width, height: erTableHeight(table.columns.length) });
    }
    for (const edge of diagram.relationships) {
      // Both endpoints are guaranteed by `buildErDiagram`, but a hand-built
      // diagram must not crash the layout either.
      if (graph.hasNode(edge.sourceTableId) && graph.hasNode(edge.targetTableId)) {
        graph.setEdge(edge.sourceTableId, edge.targetTableId);
      }
    }

    layout(graph);

    // dagre reports box centres: shift everything so the block starts at the
    // margin instead of wherever the ranking algorithm happened to land.
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const id of graph.nodes()) {
      const node = graph.node(id);
      const x = node.x - width / 2;
      const y = node.y - node.height / 2;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y + node.height);
    }
    const shiftX = ERD_MARGIN - (Number.isFinite(minX) ? minX : 0);
    const shiftY = ERD_MARGIN - (Number.isFinite(minY) ? minY : 0);
    for (const id of graph.nodes()) {
      const node = graph.node(id);
      positions[id] = { x: node.x - width / 2 + shiftX, y: node.y - node.height / 2 + shiftY };
    }
    nextRowTop = (Number.isFinite(maxY) ? maxY : ERD_MARGIN) + shiftY + ERD_ISOLATED_GAP;
  }

  if (isolated.length > 0) {
    placeIsolatedGrid(isolated, positions, width, nextRowTop);
  }
  return positions;
}

/**
 * Packs the tables without relationships into a square-ish grid whose rows are
 * as tall as the tallest box of that row, so no two boxes ever overlap.
 */
function placeIsolatedGrid(
  isolated: readonly ErTable[],
  positions: Record<string, ErPosition>,
  width: number,
  top: number,
): void {
  const columns = Math.max(1, Math.ceil(Math.sqrt(isolated.length)));
  let x = ERD_MARGIN;
  let y = top;
  let rowHeight = 0;
  isolated.forEach((table, index) => {
    const size = erTableSize(table.columns.length);
    if (index > 0 && index % columns === 0) {
      x = ERD_MARGIN;
      y += rowHeight + ERD_GAP;
      rowHeight = 0;
    }
    positions[table.id] = { x, y };
    x += width + ERD_GAP;
    rowHeight = Math.max(rowHeight, size.height);
  });
}
