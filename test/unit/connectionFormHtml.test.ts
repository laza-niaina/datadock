import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderConnectionFormHtml } from '../../src/ui/connectionFormHtml';
import { validateProfileFields } from '../../src/connections/validation';
import type { ConnectionProfile } from '../../src/db/types';
import type { DriverFactory } from '../../src/db/driverRegistry';

/** Minimal stand-in for the two `vscode.Webview` members the renderer reads. */
const webview = { cspSource: 'https://file+.vscode-resource.test' } as never;

const page = renderConnectionFormHtml(webview, { cssUri: 'https://file+.vscode-resource.test/formApp.css' });

const cspOf = (html: string): string => /content="([^"]+)"/.exec(html)?.[1] ?? '';

describe('connection form shell', () => {
  it('keeps the CSP strict: no unsafe sources, no fonts, no forms', () => {
    const csp = cspOf(page);
    assert.equal(csp.match(/unsafe-inline|unsafe-eval/g)?.length ?? 0, 0);
    assert.ok(csp.includes("default-src 'none'"));
    assert.ok(csp.includes("font-src 'none'"));
    assert.ok(csp.includes("base-uri 'none'"));
    assert.ok(csp.includes("form-action 'none'"));
    assert.ok(csp.includes('style-src https://file+.vscode-resource.test'));
    assert.ok(csp.includes("script-src 'nonce-"));
  });

  it('carries the nonce on the script and on nothing else', () => {
    const nonces = [...page.matchAll(/nonce="([A-Za-z0-9+/=]+)"/g)].map((match) => match[1]);
    assert.equal(nonces.length, 1);
    assert.ok(cspOf(page).includes(`'nonce-${nonces[0]}'`));
    assert.ok(page.includes('<script nonce='));
  });

  it('links the built stylesheet instead of inlining one', () => {
    assert.ok(page.includes('<link rel="stylesheet" href="https://file+.vscode-resource.test/formApp.css" />'));
    assert.ok(!page.includes('<style'));
  });

  it('never embeds a stored value, so no secret can leak into the markup', () => {
    // The secret inputs exist and stay empty: the host sends presence flags
    // over postMessage, never a value.
    for (const key of ['password', 'sshPassword', 'sshPrivateKey', 'sshPassphrase']) {
      const input = new RegExp(`<(?:input|textarea)[^>]*data-draft="${key}"[^>]*>`).exec(page)?.[0] ?? '';
      assert.ok(input.length > 0, `missing input for ${key}`);
      assert.ok(!/value="/.test(input), `${key} must not ship a value attribute`);
    }
    // Nothing is embedded at all: the draft travels by postMessage after the
    // webview posts `ready`, so no input may ship a value. The static
    // `<option value>` of the authentication selector is markup, not data.
    const formPart = page.slice(page.indexOf('<div class="page">'), page.indexOf('<script'));
    assert.ok(!/<(?:input|textarea)[^>]*\svalue="/.test(formPart), 'the shell must not carry any field value');
  });

  it('keeps the engine choice as an underline tab strip inside the form', () => {
    assert.ok(page.includes('id="engine-tabs"'));
    assert.ok(page.includes('class="tab-strip"'));
    assert.ok(page.includes('id="f-engine"'));
    // The single-screen flow: no catalog step, no engine drawer.
    assert.ok(!page.includes('engine-catalog'));
    assert.ok(!page.includes('engine-card'));
    assert.ok(!page.includes('step-catalog'));
    assert.ok(!page.includes('data-action="change-engine"'));
  });

  it('exposes Test Connection, Save, Close and Connect as distinct actions', () => {
    assert.ok(page.includes('data-action="test"'));
    assert.ok(page.includes('data-action="save"'));
    assert.ok(page.includes('data-action="cancel"'));
    assert.ok(page.includes('data-action="connect"'));
  });

  it('states in words that SSH is unavailable, behind a disabled fieldset', () => {
    assert.ok(page.includes('id="ssh-unavailable"'));
    assert.ok(page.includes('Not available in this build'));
    assert.ok(page.includes('<fieldset id="ssh-fields">'));
  });

  it('gives every validated field a place to show its own message', () => {
    for (const key of ['name', 'host', 'port', 'filePath', 'sshHost', 'sshUser', 'sshPort', 'sshRemotePort']) {
      assert.ok(page.includes(`data-error="${key}"`), `missing error slot for ${key}`);
    }
  });
});

describe('formApp.css invariants', () => {
  const css = readFileSync(join(__dirname, '..', '..', '..', 'src', 'ui', 'formView', 'formApp.css'), 'utf8');
  // Comments mention the banned techniques; strip them before asserting.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('imports the shared token file instead of redeclaring the palette', () => {
    assert.match(css, /@import '\.\.\/shared\/tokens\.css'/);
    assert.ok(!/--dd-fg:\s*var\(--vscode-foreground\)/.test(stripped));
  });

  it('defines no @font-face and no glyph icons', () => {
    assert.ok(!/@font-face/.test(stripped));
    // `content: ''` is allowed: the disclosure triangle is drawn from borders.
    // A quoted character would be a glyph, and that is forbidden.
    assert.ok(!/content\s*:\s*["'][^"']+["']/.test(stripped));
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(stripped));
  });

  it('sizes controls and fields on the shared scale', () => {
    assert.ok(css.includes('var(--dd-control-height)'));
    assert.ok(css.includes('var(--dd-space-2)'));
  });

  it('folds the two-column form into one column in a narrow Editor Group', () => {
    assert.match(css, /@media \(max-width: 700px\)/);
    assert.match(css, /@media \(max-width: 700px\)[\s\S]*flex: 1 1 100%/);
  });

  it('reflows the engine tabs against the panel width, not the window', () => {
    assert.match(css, /\.tab-strip\s*\{[^}]*flex-wrap:\s*wrap/);
    assert.match(css, /\.tab\.active\s*\{[^}]*box-shadow:\s*inset 0 -2px 0/);
  });
});

describe('validateProfileFields', () => {
  const factory = { engine: 'mysql', label: 'MySQL', defaultPort: 3306, fileBased: false } as DriverFactory;
  const base: ConnectionProfile = {
    id: 'c1',
    name: 'Local',
    engine: 'mysql',
    host: 'localhost',
    port: 3306,
    createdAt: 0,
    updatedAt: 0,
  };

  it('keys every problem by the draft field it belongs to', () => {
    const errors = validateProfileFields({ ...base, name: '', port: 70000 }, factory);
    assert.equal(errors.name, 'A connection name is required.');
    assert.equal(errors.port, 'The port must be between 1 and 65535.');
    assert.equal(errors.host, undefined);
  });

  it('reports a missing file path for a file engine', () => {
    const fileFactory = { engine: 'sqlite', label: 'SQLite', fileBased: true } as DriverFactory;
    const errors = validateProfileFields({ ...base, engine: 'sqlite', options: {} }, fileFactory);
    assert.equal(errors.filePath, 'A database file path is required for this engine.');
    assert.equal(errors.host, undefined);
  });

  it('reports the SSH fields only when the tunnel is enabled', () => {
    const errors = validateProfileFields(
      { ...base, ssh: { enabled: true, host: '', username: '', authMethod: 'password' } },
      factory,
    );
    assert.equal(errors.sshHost, 'An SSH host is required when the tunnel is enabled.');
    assert.equal(errors.sshUser, 'An SSH username is required when the tunnel is enabled.');
  });

  it('is silent for a well formed profile', () => {
    assert.deepEqual(validateProfileFields(base, factory), {});
  });
});
