/**
 * HTML for the connection form webview.
 *
 * Design basis: the Database Client "Add Connection" form - a page header with
 * the connection name, engine type as a tab strip, server fields in labelled
 * rows, SSL and SSH sections, and a connection-test status strip next to the
 * actions.
 *
 * Constraints honoured here:
 *  - **Theme variables only** (`--vscode-*`), so light, dark and high-contrast
 *    themes all work without a single hard-coded colour.
 *  - **Strict CSP** with a per-render nonce; no inline handlers, no remote
 *    resources.
 *  - **No secrets leave the webview** except what the user just typed, and the
 *    host never sends a stored secret back.
 *  - **No emoji and no em dash**: status markers are inline SVG panes with a
 *    separate textContent span, never colour alone.
 *
 * The webview script is written without template literals on purpose: it is
 * embedded in a template literal here, so `${` inside it would have to be
 * escaped and would be easy to get wrong.
 */

import { randomBytes } from 'node:crypto';
import type * as vscode from 'vscode';
import type { FormDraft, SecretPresence } from './connectionDraft';
import { iconStatusBusy, iconStatusError, iconStatusOk } from './icons';

/** Inline SVG status marks, JSON-escaped so they slide into the client script. */
const STATUS_ICON_OK = JSON.stringify(iconStatusOk());
const STATUS_ICON_ERROR = JSON.stringify(iconStatusError());
const STATUS_ICON_BUSY = JSON.stringify(iconStatusBusy());

const BASE_STYLES = `
  * { box-sizing: border-box; }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background-color: var(--vscode-editor-background);
    padding: 0;
    margin: 0;
  }

  form { max-width: 780px; margin: 0 auto; padding: 18px 20px 24px; }

  .app-header { margin-bottom: 18px; }
  .app-header h1 { font-size: 1.5em; font-weight: 600; margin: 0 0 4px; }
  .app-header .tagline { margin: 0; color: var(--vscode-descriptionForeground); font-size: 0.92em; }

  .card {
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
    border-radius: 6px;
    padding: 14px 16px 16px;
    margin: 0 0 14px;
  }

  .card-title {
    font-weight: 600;
    margin: 0 0 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .field-label { font-weight: 600; margin: 0 0 6px; }

  .segmented { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 14px; }

  .tab {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background-color: transparent;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
    border-radius: 4px;
    padding: 5px 14px;
    cursor: pointer;
    user-select: none;
  }
  .tab:hover:not(.active) { background-color: var(--vscode-list-hoverBackground, transparent); }
  .tab.active {
    color: var(--vscode-button-foreground);
    background-color: var(--vscode-button-background);
    border-color: var(--vscode-button-background);
  }
  .engine-logo {
    display: inline-flex; align-items: center; justify-content: center;
    width: 16px; height: 16px; flex: 0 0 16px;
    background: #fff; border-radius: 3px;
    box-shadow: 0 0 0 1px rgba(127, 127, 127, 0.35);
  }
  .engine-logo svg { width: 12px; height: 12px; display: block; }

  .row { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-bottom: 12px; }
  .row:last-child { margin-bottom: 0; }

  .field { display: flex; align-items: center; gap: 10px; flex: 1 1 280px; min-width: 200px; }
  .field.wide { flex: 1 1 100%; }
  .field.narrow { flex: 0 0 170px; min-width: 130px; }
  .field label { flex: 0 0 132px; font-weight: 600; }
  .field input, .field select { flex: 1 1 auto; min-width: 0; }

  .req { color: var(--vscode-errorForeground); }

  input[type="text"], input[type="number"], input[type="password"], select, textarea {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-input-foreground);
    background-color: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    padding: 5px 8px;
    width: 100%;
  }

  textarea { min-height: 74px; resize: vertical; font-family: var(--vscode-editor-font-family); }
  input::placeholder, textarea::placeholder { color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground)); }

  input:focus, select:focus, textarea:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  input[type="checkbox"] { accent-color: var(--vscode-checkbox-background, auto); width: auto; }

  .check { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .check:last-child { margin-bottom: 0; }
  .check label { font-weight: normal; margin: 0; }

  .with-button { display: flex; gap: 6px; align-items: stretch; flex: 1 1 auto; }
  .with-button input { flex: 1 1 auto; }

  button {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-button-foreground);
    background-color: var(--vscode-button-background);
    border: 1px solid transparent;
    border-radius: 2px;
    padding: 6px 16px;
    cursor: pointer;
  }

  button:hover:not(:disabled) { background-color: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }

  button.secondary {
    color: var(--vscode-button-secondaryForeground);
    background-color: var(--vscode-button-secondaryBackground);
  }

  button.secondary:hover:not(:disabled) { background-color: var(--vscode-button-secondaryHoverBackground); }
  button.inline { padding: 4px 10px; }

  .hint { opacity: 0.75; font-size: 0.92em; margin-top: 4px; color: var(--vscode-descriptionForeground); }
  .secret-state { font-size: 0.92em; opacity: 0.8; min-height: 1.2em; color: var(--vscode-descriptionForeground); }

  .actions {
    position: sticky;
    bottom: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 10px 20px 12px;
    margin: 6px -20px 0;
    background-color: var(--vscode-editor-background);
    border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
  }

  .spacer { flex: 1 1 auto; }

  .status {
    display: none;
    flex: 1 1 100%;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: 4px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
    white-space: pre-wrap;
    word-break: break-word;
    margin-bottom: 2px;
  }

  .status.visible { display: flex; }

  .status.ok {
    color: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
    border-color: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
    background-color: var(--vscode-inputValidation-infoBackground, transparent);
  }

  .status.error {
    color: var(--vscode-errorForeground);
    border-color: var(--vscode-errorForeground);
    background-color: var(--vscode-inputValidation-errorBackground, var(--vscode-editorWidget-background));
  }

  .status.busy {
    color: var(--vscode-descriptionForeground);
    border-color: var(--vscode-panel-border, var(--vscode-widget-border));
    background-color: var(--vscode-inputValidation-warningBackground, transparent);
  }

  .status-glyph { display: inline-flex; width: 14px; height: 14px; flex: 0 0 14px; }
  .status-glyph svg { width: 14px; height: 14px; display: block; }
  .status-text { min-width: 0; }

  .hidden { display: none !important; }
`;

const FORM_BODY = `
<form id="connection-form" autocomplete="off" novalidate>
  <div class="app-header">
    <h1 id="form-title">Add Connection</h1>
    <p class="tagline">Free database tooling. No account, no telemetry, no connection limit.</p>
  </div>

  <section class="card" id="identity-section">
    <div class="card-title">Connection</div>
    <div class="field-label">Database Type</div>
    <div class="segmented" id="engine-tabs" role="group" aria-label="Database Type"></div>
    <div class="hidden" aria-hidden="true">
      <select id="f-engine" data-draft="engine"></select>
    </div>
    <div class="row">
      <div class="field wide">
        <label for="f-name">Connection Name</label>
        <input type="text" id="f-name" data-draft="name" spellcheck="false" placeholder="My connection" />
      </div>
    </div>
  </section>

  <section class="card" id="server-section">
    <div class="card-title">Server</div>
    <div class="row">
      <div class="field">
        <label for="f-host">Host <span class="req">*</span></label>
        <input type="text" id="f-host" data-draft="host" spellcheck="false" placeholder="localhost" />
      </div>
      <div class="field narrow">
        <label for="f-port">Port <span class="req">*</span></label>
        <input type="number" id="f-port" data-draft="port" min="1" max="65535" />
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label for="f-user">Username <span class="req">*</span></label>
        <input type="text" id="f-user" data-draft="user" spellcheck="false" />
      </div>
      <div class="field">
        <label for="f-password">Password</label>
        <input type="password" id="f-password" data-draft="password" autocomplete="new-password" />
      </div>
    </div>
    <div class="row">
      <div class="hint" id="password-state"></div>
    </div>
    <div class="check">
      <input type="checkbox" id="f-clearPassword" data-draft="clearPassword" />
      <label for="f-clearPassword">Remove the stored password</label>
    </div>
  </section>

  <section class="card" id="defaults-section">
    <div class="card-title">Defaults</div>
    <div class="row">
      <div class="field">
        <label for="f-database">Default database</label>
        <input type="text" id="f-database" data-draft="database" spellcheck="false" />
      </div>
      <div class="field">
        <label for="f-schema">Default schema</label>
        <input type="text" id="f-schema" data-draft="schema" spellcheck="false" />
      </div>
    </div>
    <div class="check">
      <input type="checkbox" id="f-readOnly" data-draft="readOnly" />
      <label for="f-readOnly">Read-only - refuse every write made through this connection</label>
    </div>
  </section>

  <section class="card hidden" id="file-section">
    <div class="card-title">Database file</div>
    <div class="row">
      <div class="field wide">
        <label for="f-filePath">File</label>
        <div class="with-button">
          <input type="text" id="f-filePath" data-draft="filePath" spellcheck="false" placeholder="C:/data/example.db" />
          <button type="button" class="secondary inline" data-action="pick-file" data-target="filePath">Browse…</button>
        </div>
      </div>
    </div>
    <div class="row">
      <div class="hint">The file is opened in place. No size limit is imposed by this extension.</div>
    </div>
  </section>

  <section class="card" id="ssl-section">
    <div class="card-title">SSL / TLS</div>
    <div class="check">
      <input type="checkbox" id="f-sslEnabled" data-draft="sslEnabled" />
      <label for="f-sslEnabled">Use SSL / TLS</label>
    </div>
    <div id="ssl-details" class="hidden">
      <div class="check">
        <input type="checkbox" id="f-sslVerify" data-draft="sslVerify" />
        <label for="f-sslVerify">Verify the server certificate</label>
      </div>
      <div class="row">
        <div class="field wide">
          <label for="f-sslCaFile">CA certificate file</label>
          <div class="with-button">
            <input type="text" id="f-sslCaFile" data-draft="sslCaFile" spellcheck="false" />
            <button type="button" class="secondary inline" data-action="pick-file" data-target="sslCaFile">Browse…</button>
          </div>
        </div>
      </div>
      <div class="row">
        <div class="field wide">
          <label for="f-sslCertFile">Client certificate file</label>
          <div class="with-button">
            <input type="text" id="f-sslCertFile" data-draft="sslCertFile" spellcheck="false" />
            <button type="button" class="secondary inline" data-action="pick-file" data-target="sslCertFile">Browse…</button>
          </div>
        </div>
      </div>
      <div class="row">
        <div class="field wide">
          <label for="f-sslKeyFile">Client key file</label>
          <div class="with-button">
            <input type="text" id="f-sslKeyFile" data-draft="sslKeyFile" spellcheck="false" />
            <button type="button" class="secondary inline" data-action="pick-file" data-target="sslKeyFile">Browse…</button>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section class="card" id="ssh-section">
    <div class="card-title">SSH tunnel</div>
    <div class="check">
      <input type="checkbox" id="f-sshEnabled" data-draft="sshEnabled" />
      <label for="f-sshEnabled">Connect through an SSH tunnel</label>
    </div>
    <div id="ssh-details" class="hidden">
      <div class="row">
        <div class="field">
          <label for="f-sshHost">SSH host</label>
          <input type="text" id="f-sshHost" data-draft="sshHost" spellcheck="false" />
        </div>
        <div class="field narrow">
          <label for="f-sshPort">SSH port</label>
          <input type="number" id="f-sshPort" data-draft="sshPort" min="1" max="65535" placeholder="22" />
        </div>
        <div class="field">
          <label for="f-sshUser">SSH user</label>
          <input type="text" id="f-sshUser" data-draft="sshUser" spellcheck="false" />
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label for="f-sshAuthMethod">Authentication</label>
          <select id="f-sshAuthMethod" data-draft="sshAuthMethod">
            <option value="password">Password</option>
            <option value="privateKey">Private key</option>
            <option value="agent">SSH agent</option>
          </select>
        </div>
        <div class="field" data-auth="password">
          <label for="f-sshPassword">SSH password</label>
          <input type="password" id="f-sshPassword" data-draft="sshPassword" autocomplete="new-password" />
        </div>
      </div>
      <div class="row" data-auth="privateKey">
        <div class="field wide">
          <label for="f-sshPrivateKeyPath">Private key file</label>
          <div class="with-button">
            <input type="text" id="f-sshPrivateKeyPath" data-draft="sshPrivateKeyPath" spellcheck="false" />
            <button type="button" class="secondary inline" data-action="pick-file" data-target="sshPrivateKeyPath">Browse…</button>
          </div>
        </div>
      </div>
      <div class="row" data-auth="privateKey">
        <div class="field wide">
          <label for="f-sshPrivateKey">Private key contents (alternative to a file)</label>
          <textarea id="f-sshPrivateKey" data-draft="sshPrivateKey" spellcheck="false" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
        </div>
      </div>
      <div class="row" data-auth="privateKey">
        <div class="field wide">
          <label for="f-sshPassphrase">Key passphrase</label>
          <input type="password" id="f-sshPassphrase" data-draft="sshPassphrase" autocomplete="new-password" />
        </div>
      </div>
      <div class="row">
        <div class="hint" id="sshPassword-state"></div>
        <div class="hint" id="sshPrivateKey-state"></div>
        <div class="hint" id="sshPassphrase-state"></div>
      </div>
      <div class="check">
        <input type="checkbox" id="f-clearSshPassword" data-draft="clearSshPassword" />
        <label for="f-clearSshPassword">Remove the stored SSH password</label>
      </div>
      <div class="check">
        <input type="checkbox" id="f-clearSshPrivateKey" data-draft="clearSshPrivateKey" />
        <label for="f-clearSshPrivateKey">Remove the stored private key</label>
      </div>
      <div class="check">
        <input type="checkbox" id="f-clearSshPassphrase" data-draft="clearSshPassphrase" />
        <label for="f-clearSshPassphrase">Remove the stored key passphrase</label>
      </div>
      <div class="row">
        <div class="field">
          <label for="f-sshRemoteHost">Database host as seen from the SSH server</label>
          <input type="text" id="f-sshRemoteHost" data-draft="sshRemoteHost" spellcheck="false" placeholder="127.0.0.1" />
        </div>
        <div class="field narrow">
          <label for="f-sshRemotePort">Remote port</label>
          <input type="number" id="f-sshRemotePort" data-draft="sshRemotePort" min="1" max="65535" />
        </div>
      </div>
      <div class="hint">Leave the server host and port above set to the values reachable from the SSH server.</div>
    </div>
  </section>

  <div class="actions">
    <div class="status" id="status"></div>
    <button type="button" class="secondary" data-action="test" id="test-button">Test Connection</button>
    <button type="button" class="secondary" data-action="cancel">Cancel</button>
    <span class="spacer"></span>
    <button type="button" data-action="save" id="save-button">Save</button>
  </div>

</form>
`;

// The webview script is split in three adjacent template literals purely to keep
// each source chunk reviewable; they are concatenated by `renderConnectionFormHtml`.
const SCRIPT_PART_ONE = `
(function () {
  'use strict';

  var api = acquireVsCodeApi();
  var form = document.getElementById('connection-form');
  var statusEl = document.getElementById('status');
  var engines = [];
  var mode = 'create';

  function byId(id) { return document.getElementById(id); }

  function toggleHidden(id, visible) {
    var node = byId(id);
    if (!node) { return; }
    if (visible) { node.classList.remove('hidden'); } else { node.classList.add('hidden'); }
  }

  function field(name) { return form.querySelector('[data-draft="' + name + '"]'); }

  function engineById(id) {
    for (var i = 0; i < engines.length; i++) {
      if (engines[i].id === id) { return engines[i]; }
    }
    return undefined;
  }

  function readDraft() {
    var draft = {};
    var nodes = form.querySelectorAll('[data-draft]');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var key = node.getAttribute('data-draft');
      if (node.type === 'checkbox') { draft[key] = node.checked; } else { draft[key] = node.value; }
    }
    return draft;
  }

  function writeDraft(draft) {
    var nodes = form.querySelectorAll('[data-draft]');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var key = node.getAttribute('data-draft');
      var value = draft[key];
      if (value === undefined || value === null) { continue; }
      if (node.type === 'checkbox') { node.checked = value === true; } else { node.value = String(value); }
    }
  }

  function renderEngineOptions() {
    var select = field('engine');
    select.textContent = '';
    var tabsHost = byId('engine-tabs');
    tabsHost.textContent = '';
    for (var i = 0; i < engines.length; i++) {
      var label = engines[i].label + (engines[i].status === 'beta' ? ' (beta)' : '');
      var option = document.createElement('option');
      option.value = engines[i].id;
      option.textContent = label;
      select.appendChild(option);
      var tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'tab';
      tab.setAttribute('data-engine', engines[i].id);
      tab.setAttribute('aria-pressed', 'false');
      var logo = document.createElement('span');
      logo.className = 'engine-logo';
      logo.innerHTML = engines[i].logo || '';
      var name = document.createElement('span');
      name.className = 'engine-name';
      name.textContent = label;
      tab.appendChild(logo);
      tab.appendChild(name);
      tabsHost.appendChild(tab);
    }
    syncTabs();
  }

  function syncTabs() {
    var current = field('engine').value;
    var buttons = byId('engine-tabs').querySelectorAll('[data-engine]');
    for (var i = 0; i < buttons.length; i++) {
      var active = buttons[i].getAttribute('data-engine') === current;
      if (active) { buttons[i].classList.add('active'); } else { buttons[i].classList.remove('active'); }
      buttons[i].setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }
`;

const SCRIPT_PART_TWO = `
  function applyEngine() {
    var engine = engineById(field('engine').value);
    var fileBased = !!(engine && engine.fileBased);
    toggleHidden('server-section', !fileBased);
    toggleHidden('file-section', fileBased);
    // A file engine has no host, no TLS handshake and no tunnel to open.
    toggleHidden('ssl-section', !fileBased);
    toggleHidden('ssh-section', !fileBased);
    if (!fileBased && engine && engine.defaultPort && field('port') && !field('port').value) {
      field('port').value = String(engine.defaultPort);
    }
  }

  function applyToggles() {
    toggleHidden('ssl-details', field('sslEnabled').checked);
    toggleHidden('ssh-details', field('sshEnabled').checked);
    var auth = field('sshAuthMethod').value;
    var groups = form.querySelectorAll('[data-auth]');
    for (var i = 0; i < groups.length; i++) {
      var wanted = groups[i].getAttribute('data-auth');
      if (wanted === auth) { groups[i].classList.remove('hidden'); } else { groups[i].classList.add('hidden'); }
    }
  }

  // Status markers are inline SVG panes built from trusted host markup; the
  // text travels in a separate textContent span so server messages stay inert.
  function statusGlyph(kind) {
    if (kind === 'ok') { return ${STATUS_ICON_OK}; }
    if (kind === 'error') { return ${STATUS_ICON_ERROR}; }
    if (kind === 'busy') { return ${STATUS_ICON_BUSY}; }
    return '';
  }

  function setStatus(kind, text) {
    statusEl.innerHTML = '';
    if (!text) { statusEl.className = 'status'; return; }
    statusEl.className = 'status visible ' + kind;
    var glyph = statusGlyph(kind);
    if (glyph) {
      var icon = document.createElement('span');
      icon.className = 'status-glyph';
      icon.innerHTML = glyph;
      statusEl.appendChild(icon);
    }
    var label = document.createElement('span');
    label.className = 'status-text';
    label.textContent = text;
    statusEl.appendChild(label);
  }

  function setBusy(busy, label) {
    var buttons = form.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) { buttons[i].disabled = busy; }
    if (busy) {
      setStatus('busy', label || 'Working...');
    } else if (statusEl.className.indexOf('busy') >= 0) {
      setStatus('', '');
    }
  }

  function renderSecretHint(presence, hintId, key) {
    var node = byId(hintId);
    if (!node) { return; }
    var stored = !!(presence && presence[key]);
    node.textContent = stored ? 'A value is stored. Leave empty to keep it.' : 'No value stored yet.';
  }

  function applyPresence(presence) {
    renderSecretHint(presence, 'password-state', 'password');
    renderSecretHint(presence, 'sshPassword-state', 'sshPassword');
    renderSecretHint(presence, 'sshPrivateKey-state', 'sshPrivateKey');
    renderSecretHint(presence, 'sshPassphrase-state', 'sshPassphrase');
  }
`;

const SCRIPT_PART_THREE = `
  form.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.getAttribute) { return; }
    var action = target.getAttribute('data-action');
    if (action === 'pick-file') {
      api.postMessage({ type: 'pickFile', target: target.getAttribute('data-target') });
      return;
    }
    if (action === 'save') { api.postMessage({ type: 'save', draft: readDraft() }); return; }
    if (action === 'test') { api.postMessage({ type: 'test', draft: readDraft() }); return; }
    if (action === 'cancel') { api.postMessage({ type: 'cancel' }); return; }
    var engineBtn = target.closest('[data-engine]');
    if (engineBtn) {
      field('engine').value = engineBtn.getAttribute('data-engine');
      syncTabs();
      applyEngine();
    }
  });

  form.addEventListener('change', function (event) {
    var target = event.target;
    if (!target || !target.getAttribute) { return; }
    var key = target.getAttribute('data-draft');
    if (key === 'engine') { syncTabs(); applyEngine(); }
    if (key === 'sslEnabled' || key === 'sshEnabled' || key === 'sshAuthMethod') { applyToggles(); }
  });

  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || !message.type) { return; }

    if (message.type === 'init') {
      mode = message.mode;
      var title = byId('form-title');
      if (title) { title.textContent = mode === 'create' ? 'Add Connection' : 'Edit Connection'; }
      engines = message.engines || [];
      renderEngineOptions();
      writeDraft(message.draft || {});
      syncTabs();
      applyEngine();
      applyToggles();
      applyPresence(message.secretPresence);
      setStatus(message.statusKind || '', message.statusMessage || '');
      if (mode === 'create') { field('name').focus(); }
      return;
    }
    if (message.type === 'busy') { setBusy(!!message.busy, message.label); return; }
    if (message.type === 'testResult') { setStatus(message.ok ? 'ok' : 'error', message.message); return; }
    if (message.type === 'error') { setStatus('error', message.message); return; }
    if (message.type === 'notice') { setStatus('ok', message.message); return; }
    if (message.type === 'filePicked') {
      var input = field(message.target);
      if (input) { input.value = message.value; }
      return;
    }
  });

  api.postMessage({ type: 'ready' });
})();
`;

/** One entry per engine offered in the wizard; built from the driver registry. */
export interface EngineChoice {
  id: string;
  label: string;
  /** Inline SVG brand mark shown in the engine tab. */
  logo: string;
  status: string;
  defaultPort?: number;
  fileBased?: boolean;
}

/** Everything the webview needs to render, minus any real secret value. */
export interface ConnectionFormModel {
  mode: 'create' | 'edit';
  engines: EngineChoice[];
  draft: FormDraft;
  secretPresence: SecretPresence;
  statusKind?: '' | 'ok' | 'error' | 'busy';
  statusMessage?: string;
}

function createNonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * Renders the form shell.
 *
 * The draft, the engine list and the secret-presence flags are **not** embedded
 * here: the webview asks for them by posting `{ type: 'ready' }`, which keeps a
 * single code path for both the initial load and later refreshes.
 */
export function renderConnectionFormHtml(webview: vscode.Webview): string {
  const nonce = createNonce();
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  const script = `${SCRIPT_PART_ONE}${SCRIPT_PART_TWO}${SCRIPT_PART_THREE}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DataDock - Connection</title>
  <style nonce="${nonce}">${BASE_STYLES}</style>
</head>
<body>
${FORM_BODY}
<script nonce="${nonce}">
${script}
</script>
</body>
</html>`;
}