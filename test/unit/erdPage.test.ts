import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderErPage } from '../../src/ui/erd/erdPage';

const ASSETS = {
  jsUri: 'https://file%2B.vscode-resource.test/dist/webview/erdApp.js',
  cssUri: 'https://file%2B.vscode-resource.test/dist/webview/erdApp.css',
  cspSource: 'https://file%2B.vscode-resource.test',
};

describe('renderErPage', () => {
  const html = renderErPage(
    ASSETS,
    { title: 'shop', connectionName: 'Local Shop', database: 'shop' },
    'ER Diagram: shop',
  );

  it('serves a strict CSP with a per-render nonce and no fallbacks', () => {
    const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
    assert.ok(csp, 'a CSP meta tag is present');
    assert.match(csp, /^default-src 'none'; /);
    assert.match(csp, /style-src https:\/\/file%2B\.vscode-resource\.test 'nonce-/);
    assert.match(csp, /script-src https:\/\/file%2B\.vscode-resource\.test 'nonce-/);
    // Neither relaxation that would let inline script or eval through.
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.doesNotMatch(csp, /unsafe-eval/);
    assert.match(csp, /font-src 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /form-action 'none'/);
  });

  it('reuses the same nonce for the inline island and the CSP', () => {
    const nonce = html.match(/<script nonce="([^"]+)">globalThis\.__DATADOCK_ERD__=/)?.[1];
    assert.ok(nonce, 'an inline island declares the nonce');
    assert.ok(nonce.length > 16, 'the nonce is not a placeholder');
    assert.ok(html.includes(`'nonce-${nonce}'`), 'the CSP allows exactly that nonce');
    assert.equal(html.split(`'nonce-${nonce}'`).length - 1, 2, 'style-src and script-src');
  });

  it('declares the identity island before the bundle it boots', () => {
    const islandAt = html.indexOf('globalThis.__DATADOCK_ERD__=');
    const bundleAt = html.indexOf('erdApp.js');
    assert.ok(islandAt > 0, 'the island exists');
    assert.ok(bundleAt > islandAt, 'the bundle is loaded after the island');
    assert.match(html, /"connectionName":"Local Shop"/);
    assert.match(html, /"database":"shop"/);
    // Nothing that could identify a credential ever reaches the webview.
    assert.doesNotMatch(html, /password|secret|token/i);
  });

  it('points at the ERD bundle and stylesheet of the shared webview folder', () => {
    assert.ok(html.includes('href="https://file%2B.vscode-resource.test/dist/webview/erdApp.css"'));
    assert.ok(html.includes('src="https://file%2B.vscode-resource.test/dist/webview/erdApp.js"'));
    assert.ok(html.includes('<div id="app"></div>'));
  });

  it('escapes the page title', () => {
    const escaped = renderErPage(ASSETS, { title: 'shop', connectionName: 'A & B' }, 'ER <shop>');
    assert.match(escaped, /<title>ER &lt;shop&gt;<\/title>/);
    assert.match(escaped, /"connectionName":"A & B"/);
  });

  it('emits a complete, standalone document', () => {
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.trimEnd().endsWith('</html>'));
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<meta charset="UTF-8" \/>/);
  });
});
