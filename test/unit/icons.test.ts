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
  iconFunnel,
  iconRefresh,
  iconReveal,
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
  ];

  it('renders every icon as a self-contained inline svg', () => {
    for (const [name, svg] of icons) {
      assert.ok(svg.startsWith('<svg'), `${name} prefix`);
      assert.ok(svg.endsWith('</svg>'), `${name} suffix`);
      assert.ok(svg.includes('viewBox='), `${name} viewBox`);
    }
  });
});