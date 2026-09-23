import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_ASSETS_DIR, resolveAssetsDir } from '../../src/db/drivers/assets';

describe('resolveAssetsDir', () => {
  it('falls back to the bundle directory for blank input', () => {
    assert.equal(resolveAssetsDir(), DEFAULT_ASSETS_DIR);
    assert.equal(resolveAssetsDir(''), DEFAULT_ASSETS_DIR);
    assert.equal(resolveAssetsDir('   '), DEFAULT_ASSETS_DIR);
  });

  it('returns a real path verbatim (trimmed)', () => {
    const custom = path.join('C:', 'ext', 'dist');
    assert.equal(resolveAssetsDir(custom), custom);
    assert.equal(resolveAssetsDir(`  ${custom}  `), custom);
  });

  it('exposes an absolute default (the directory of the compiled module)', () => {
    // Under the bundle this is <extension>/dist; under `tsc` test builds it is
    // the directory of the compiled assets module. Either way it is absolute.
    assert.equal(path.isAbsolute(DEFAULT_ASSETS_DIR), true);
  });
});
