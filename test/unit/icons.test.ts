import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EngineId } from '../../src/db/types';
import {
  ENGINE_SVGS,
  getEngineIcon,
  iconArrowRight,
  iconChevron,
  iconClose,
  iconCopy,
  iconDot,
  iconEye,
  iconEyeOff,
  iconFit,
  iconFunnel,
  iconHashtagMark,
  iconKeyMark,
  iconLayout,
  iconMinus,
  iconPlus,
  iconRefresh,
  iconResetPositions,
  iconReveal,
  iconSearch,
  iconStatusBusy,
  iconStatusError,
  iconStatusOk,
  iconTranspose,
} from '../../src/ui/icons';

describe('engine marks', () => {
  it('resolves every supported engine to its shipped file and inline svg', () => {
    const expected: Record<string, string> = {
      mysql: 'mysql.svg',
      mariadb: 'mariadb.svg',
      postgresql: 'pg_server.svg',
      sqlite: 'sqlite-icon.svg',
      mssql: 'mssql_server.png',
    };
    for (const [engine, file] of Object.entries(expected)) {
      const icon = getEngineIcon(engine as EngineId);
      assert.equal(icon.file, file, `${engine} file`);
      assert.ok(icon.svg.startsWith('<svg'), `${engine} svg prefix`);
      assert.ok(icon.svg.length > 60, `${engine} svg length`);
    }
  });

  it('falls back to the generic container mark for unmarked engines', () => {
    assert.equal(getEngineIcon('mongodb').file, 'database-container.svg');
    assert.equal(getEngineIcon('redis').file, 'database-container.svg');
  });

  it('ships bare svg markup (no XML declarations, DOCTYPEs or comments)', () => {
    for (const [key, svg] of Object.entries(ENGINE_SVGS)) {
      assert.ok(svg.startsWith('<svg'), `${key} starts with <svg`);
      assert.ok(!svg.includes('<?xml'), `${key} has no XML declaration`);
      assert.ok(!svg.includes('<!DOCTYPE'), `${key} has no DOCTYPE`);
      assert.ok(!svg.includes('<!--'), `${key} has no comments`);
    }
  });

  // The webview CSP is `style-src <cspSource> 'nonce-…'`: a nonce never
  // covers style *attributes*, so the browser strips them and the mark
  // paints with default (black) fill. Presentation attributes are immune.
  it('declares no style attributes (CSP strips them; marks render black)', () => {
    for (const [key, svg] of Object.entries(ENGINE_SVGS)) {
      assert.ok(!/ style="/.test(svg), `${key} has no style attribute`);
    }
  });
});

describe('generic UI icons', () => {
  const icons: Array<[string, string]> = [
    ['chevron up', iconChevron('up')],
    ['chevron down', iconChevron('down')],
    ['chevron left', iconChevron('left')],
    ['chevron right', iconChevron('right')],
    ['funnel', iconFunnel()],
    ['close', iconClose()],
    ['refresh', iconRefresh()],
    ['transpose', iconTranspose()],
    ['copy', iconCopy()],
    ['arrow right', iconArrowRight()],
    ['reveal', iconReveal()],
    ['dot', iconDot()],
    ['status ok', iconStatusOk()],
    ['status error', iconStatusError()],
    ['status busy', iconStatusBusy()],
    ['primary key', iconKeyMark()],
    ['foreign key', iconHashtagMark()],
    ['search', iconSearch()],
    ['zoom in', iconPlus()],
    ['zoom out', iconMinus()],
    ['fit', iconFit()],
    ['auto layout', iconLayout()],
    ['reset positions', iconResetPositions()],
    ['show unrelated', iconEye()],
    ['hide unrelated', iconEyeOff()],
  ];

  it('renders every icon as a self-contained inline svg', () => {
    for (const [name, svg] of icons) {
      assert.ok(svg.startsWith('<svg'), `${name} prefix`);
      assert.ok(svg.endsWith('</svg>'), `${name} suffix`);
      assert.ok(svg.includes('viewBox='), `${name} viewBox`);
    }
  });

  it('draws the schema key marks instead of spelling a glyph', () => {
    // A key and a hashtag are declared schema facts, so they are icons: no
    // `#` character, no emoji, no private-use codepoint, and the hue comes
    // from the stylesheet rather than being written into the markup.
    for (const [name, svg] of [
      ['primary key', iconKeyMark()],
      ['foreign key', iconHashtagMark()],
    ] as const) {
      assert.ok(svg.includes('currentColor'), `${name} follows the token colour`);
      assert.ok(!/#[0-9a-f]{3,8}\b/i.test(svg.replace('viewBox', '')), `${name} carries no literal colour`);
      assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{E000}-\u{F8FF}]/u.test(svg), `${name} has no glyph`);
      assert.ok(!/<text/.test(svg), `${name} is not a text node`);
      assert.ok(svg.includes('aria-hidden="true"'), `${name} is hidden from the tree`);
    }
    // The hashtag must not be the `#` character wearing an svg costume.
    assert.ok(!iconHashtagMark().includes('#'), 'the foreign-key mark draws its bars');
  });

  it('draws the ER diagram toolbar icons instead of spelling glyphs', () => {
    const toolbar: Array<[string, string]> = [
      ['search', iconSearch()],
      ['zoom in', iconPlus()],
      ['zoom out', iconMinus()],
      ['fit', iconFit()],
      ['auto layout', iconLayout()],
      ['reset positions', iconResetPositions()],
      ['show unrelated', iconEye()],
      ['hide unrelated', iconEyeOff()],
    ];
    for (const [name, svg] of toolbar) {
      assert.ok(svg.includes('currentColor'), `${name} follows the token colour`);
      assert.ok(!/#[0-9a-f]{3,8}\b/i.test(svg.replace('viewBox', '')), `${name} carries no literal colour`);
      assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{E000}-\u{F8FF}]/u.test(svg), `${name} has no glyph`);
      assert.ok(!/<text/.test(svg), `${name} is not a text node`);
      assert.ok(svg.includes('aria-hidden="true"'), `${name} is hidden from the tree`);
    }
  });
});