/**
 * HTML for the connection form webview.
 *
 * Design basis (DataDock identity, DB Explorer / Database Client interaction):
 *  - **Database type first**, as an underline tab strip with the real engine
 *    marks, then the settings of the selected engine.
 *  - **Dense form, roomy layout**: controls are 30px on a 4/8/12/16/24 scale,
 *    two label-left columns that fold to one in a narrow Editor Group.
 *  - **Validation next to the field** it belongs to, plus one status band that
 *    states the kind of result in words (never colour alone).
 *  - **No fakes**: a capability the backend does not implement is rendered
 *    with its controls disabled and an explicit note, never as a button that
 *    pretends to work.
 *
 * Constraints honoured here:
 *  - **Theme variables only** (`--vscode-*` through the shared tokens), so
 *    light, dark and high-contrast themes work with no hard-coded palette.
 *  - **Strict CSP** with a per-render nonce; no inline handlers, no remote
 *    resources, the stylesheet is a local file served through `asWebviewUri`.
 *  - **No secrets leave the webview** except what the user just typed, and the
 *    host never sends a stored secret back.
 *  - **No emoji, no glyph icon, no em dash**.
 *
 * The webview script is written without template literals on purpose: it is
 * embedded in a template literal here, so `${` inside it would have to be
 * escaped and would be easy to get wrong.
 */

import { randomBytes } from 'node:crypto';
import type * as vscode from 'vscode';
import type { FormDraft, SecretPresence } from './connectionDraft';

/** Local files the webview is allowed to load. */
export interface ConnectionFormAssets {
  /** Stylesheet built by the esbuild webview entry. */
  readonly cssUri: string;
}

const FORM_BODY = `
<div class="page">
  <div class="app-header">
    <h1 id="form-title">Connect to Database Server</h1>
    <p class="tagline">DataDock - free database tooling. No account, no telemetry, no connection limit.</p>
  </div>

  <blockquote class="panel" id="status" aria-live="polite"></blockquote>

  <div class="block">
    <div class="field-label">Database Type</div>
    <ul class="tab-strip" id="engine-tabs" role="group" aria-label="Database Type"></ul>
    <div class="hidden" aria-hidden="true">
      <select id="f-engine" data-draft="engine"></select>
    </div>
  </div>

  <form id="connection-form" autocomplete="off" novalidate">
      <div class="block">
        <div class="row">
          <div class="field">
            <div class="field-line">
              <label for="f-name">Connection Name</label>
              <input type="text" id="f-name" data-draft="name" spellcheck="false" placeholder="e.g. Local MariaDB" />
            </div>
            <p class="field-error" data-error="name" hidden></p>
          </div>
        </div>
      </div>

      <div id="server-fields">
        <div class="row">
          <div class="field">
            <div class="field-line">
              <label for="f-host">Host <span class="req">*</span></label>
              <input type="text" id="f-host" data-draft="host" spellcheck="false" placeholder="localhost" />
            </div>
            <p class="field-error" data-error="host" hidden></p>
          </div>
          <div class="field narrow">
            <div class="field-line">
              <label for="f-port">Port</label>
              <input type="number" id="f-port" data-draft="port" min="1" max="65535" placeholder="3306" />
            </div>
            <p class="field-error" data-error="port" hidden></p>
          </div>
        </div>
        <div class="row">
          <div class="field">
            <div class="field-line">
              <label for="f-user">Username</label>
              <input type="text" id="f-user" data-draft="user" spellcheck="false" placeholder="root" />
            </div>
            <p class="field-error" data-error="user" hidden></p>
          </div>
          <div class="field">
            <div class="field-line">
              <label for="f-password">Password</label>
              <input type="password" id="f-password" data-draft="password" autocomplete="new-password" />
            </div>
            <p class="field-error" data-error="password" hidden></p>
          </div>
        </div>
        <div class="row">
          <div class="field wide">
            <div class="hint" id="password-state"></div>
          </div>
        </div>
        <div class="check">
          <input type="checkbox" id="f-clearPassword" data-draft="clearPassword" />
          <label for="f-clearPassword">Remove the stored password</label>
        </div>
      </div>

      <div id="file-fields" class="hidden">
        <div class="row">
          <div class="field wide">
            <div class="field-line">
              <label for="f-filePath">File</label>
              <div class="with-button">
                <input type="text" id="f-filePath" data-draft="filePath" spellcheck="false" placeholder="C:/data/example.db" />
                <button type="button" class="secondary" data-action="pick-file" data-target="filePath">Browse...</button>
              </div>
            </div>
            <p class="field-error" data-error="filePath" hidden></p>
          </div>
        </div>
        <div class="row">
          <div class="field wide">
            <p class="hint">The file is opened in place. No size limit is imposed by this extension.</p>
          </div>
        </div>
      </div>

      <div class="block">
        <div class="row">
          <div class="field">
            <div class="field-line">
              <label for="f-database">Default database</label>
              <input type="text" id="f-database" data-draft="database" spellcheck="false" placeholder="e.g. learn" />
            </div>
            <p class="field-error" data-error="database" hidden></p>
          </div>
          <div class="field">
            <div class="field-line">
              <label for="f-schema">Default schema</label>
              <input type="text" id="f-schema" data-draft="schema" spellcheck="false" />
            </div>
            <p class="field-error" data-error="schema" hidden></p>
          </div>
        </div>
        <div class="check">
          <input type="checkbox" id="f-readOnly" data-draft="readOnly" />
          <label for="f-readOnly">Read-only - refuse every write made through this connection</label>
        </div>
      </div>

      <details class="section hidden" id="ssl-section">
        <summary>SSL / TLS <span class="section-state" id="ssl-state"></span></summary>
        <div class="section-body">
          <div class="check">
            <input type="checkbox" id="f-sslEnabled" data-draft="sslEnabled" />
            <label for="f-sslEnabled">Use SSL / TLS</label>
          </div>
          <div id="ssl-advanced" class="hidden">
            <div class="check">
              <input type="checkbox" id="f-sslVerify" data-draft="sslVerify" />
              <label for="f-sslVerify">Verify the server certificate</label>
            </div>
            <div class="row">
              <div class="field wide">
                <div class="field-line">
                  <label for="f-sslServerName">Server name (SNI)</label>
                  <input type="text" id="f-sslServerName" data-draft="sslServerName" spellcheck="false" />
                </div>
                <p class="field-error" data-error="sslServerName" hidden></p>
              </div>
            </div>
            <div class="row">
              <div class="field wide">
                <div class="field-line">
                  <label for="f-sslCaFile">CA certificate</label>
                  <div class="with-button">
                    <input type="text" id="f-sslCaFile" data-draft="sslCaFile" spellcheck="false" />
                    <button type="button" class="secondary" data-action="pick-file" data-target="sslCaFile">Browse...</button>
                  </div>
                </div>
                <p class="field-error" data-error="sslCaFile" hidden></p>
              </div>
            </div>
            <div class="row">
              <div class="field wide">
                <div class="field-line">
                  <label for="f-sslCertFile">Client certificate</label>
                  <div class="with-button">
                    <input type="text" id="f-sslCertFile" data-draft="sslCertFile" spellcheck="false" />
                    <button type="button" class="secondary" data-action="pick-file" data-target="sslCertFile">Browse...</button>
                  </div>
                </div>
                <p class="field-error" data-error="sslCertFile" hidden></p>
              </div>
            </div>
            <div class="row">
              <div class="field wide">
                <div class="field-line">
                  <label for="f-sslKeyFile">Client key</label>
                  <div class="with-button">
                    <input type="text" id="f-sslKeyFile" data-draft="sslKeyFile" spellcheck="false" />
                    <button type="button" class="secondary" data-action="pick-file" data-target="sslKeyFile">Browse...</button>
                  </div>
                </div>
                <p class="field-error" data-error="sslKeyFile" hidden></p>
              </div>
            </div>
          </div>
        </div>
      </details>

      <details class="section hidden" id="ssh-section">
        <summary>SSH tunnel <span class="section-state" id="ssh-state"></span></summary>
        <div class="section-body">
          <p class="notice hidden" id="ssh-unavailable"><strong>Not available in this build.</strong> No SSH transport is bundled, so a tunnel cannot be opened. Use a network-level tunnel (for example an OS-level SSH forward) and point the host and port at its local end.</p>
          <fieldset id="ssh-fields">
            <div class="check">
              <input type="checkbox" id="f-sshEnabled" data-draft="sshEnabled" />
              <label for="f-sshEnabled">Connect through an SSH tunnel</label>
            </div>
            <div id="ssh-advanced" class="hidden">
              <div class="row">
                <div class="field">
                  <div class="field-line">
                    <label for="f-sshHost">SSH host</label>
                    <input type="text" id="f-sshHost" data-draft="sshHost" spellcheck="false" />
                  </div>
                  <p class="field-error" data-error="sshHost" hidden></p>
                </div>
                <div class="field narrow">
                  <div class="field-line">
                    <label for="f-sshPort">SSH port</label>
                    <input type="number" id="f-sshPort" data-draft="sshPort" min="1" max="65535" placeholder="22" />
                  </div>
                  <p class="field-error" data-error="sshPort" hidden></p>
                </div>
                <div class="field">
                  <div class="field-line">
                    <label for="f-sshUser">SSH user</label>
                    <input type="text" id="f-sshUser" data-draft="sshUser" spellcheck="false" />
                  </div>
                  <p class="field-error" data-error="sshUser" hidden></p>
                </div>
              </div>
              <div class="row">
                <div class="field">
                  <div class="field-line">
                    <label for="f-sshAuthMethod">Authentication</label>
                    <select id="f-sshAuthMethod" data-draft="sshAuthMethod">
                      <option value="password">Password</option>
                      <option value="privateKey">Private key</option>
                      <option value="agent">SSH agent</option>
                    </select>
                  </div>
                  <p class="field-error" data-error="sshAuthMethod" hidden></p>
                </div>
                <div class="field" data-auth="password">
                  <div class="field-line">
                    <label for="f-sshPassword">SSH password</label>
                    <input type="password" id="f-sshPassword" data-draft="sshPassword" autocomplete="new-password" />
                  </div>
                  <p class="field-error" data-error="sshPassword" hidden></p>
                </div>
              </div>
              <div class="row" data-auth="privateKey">
                <div class="field wide">
                  <div class="field-line">
                    <label for="f-sshPrivateKeyPath">Private key file</label>
                    <div class="with-button">
                      <input type="text" id="f-sshPrivateKeyPath" data-draft="sshPrivateKeyPath" spellcheck="false" />
                      <button type="button" class="secondary" data-action="pick-file" data-target="sshPrivateKeyPath">Browse...</button>
                    </div>
                  </div>
                  <p class="field-error" data-error="sshPrivateKeyPath" hidden></p>
                </div>
              </div>
              <div class="row" data-auth="privateKey">
                <div class="field wide">
                  <div class="field-line">
                    <label for="f-sshPrivateKey">Key contents</label>
                    <textarea id="f-sshPrivateKey" data-draft="sshPrivateKey" spellcheck="false" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
                  </div>
                  <p class="field-error" data-error="sshPrivateKey" hidden></p>
                </div>
              </div>
              <div class="row" data-auth="privateKey">
                <div class="field wide">
                  <div class="field-line">
                    <label for="f-sshPassphrase">Key passphrase</label>
                    <input type="password" id="f-sshPassphrase" data-draft="sshPassphrase" autocomplete="new-password" />
                  </div>
                  <p class="field-error" data-error="sshPassphrase" hidden></p>
                </div>
              </div>
              <div class="row">
                <div class="field wide"><div class="secret-state" id="sshPassword-state"></div></div>
                <div class="field wide"><div class="secret-state" id="sshPrivateKey-state"></div></div>
                <div class="field wide"><div class="secret-state" id="sshPassphrase-state"></div></div>
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
                  <div class="field-line">
                    <label for="f-sshRemoteHost">DB host from SSH server</label>
                    <input type="text" id="f-sshRemoteHost" data-draft="sshRemoteHost" spellcheck="false" placeholder="127.0.0.1" />
                  </div>
                  <p class="field-error" data-error="sshRemoteHost" hidden></p>
                </div>
                <div class="field narrow">
                  <div class="field-line">
                    <label for="f-sshRemotePort">Remote port</label>
                    <input type="number" id="f-sshRemotePort" data-draft="sshRemotePort" min="1" max="65535" />
                  </div>
                  <p class="field-error" data-error="sshRemotePort" hidden></p>
                </div>
              </div>
            </div>
          </fieldset>
        </div>
      </details>

      <div class="actions">
        <button type="button" class="secondary" data-action="test" id="test-button">Test Connection</button>
        <button type="button" class="secondary" data-action="save" id="save-button">Save</button>
        <button type="button" class="secondary" data-action="cancel">Close</button>
        <span class="spacer"></span>
        <button type="button" data-action="connect" id="connect-button">Connect</button>
      </div>
    </form>
</div>
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
  var sshSupported = false;
  var autoName = '';

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

  function engineLabel(engine) {
    return engine.label + (engine.status === 'beta' ? ' (beta)' : '');
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

  // Database type as an underline tab strip: one tab per engine the registry
  // reports as available, with its real mark.
  function renderEngineOptions() {
    var select = field('engine');
    select.textContent = '';
    var host = byId('engine-tabs');
    host.textContent = '';
    for (var i = 0; i < engines.length; i++) {
      var engine = engines[i];
      var option = document.createElement('option');
      option.value = engine.id;
      option.textContent = engineLabel(engine);
      select.appendChild(option);
      var tab = document.createElement('li');
      tab.className = 'tab';
      tab.setAttribute('data-engine', engine.id);
      tab.setAttribute('role', 'button');
      tab.setAttribute('tabindex', '0');
      tab.setAttribute('aria-pressed', 'false');
      var mark = document.createElement('span');
      mark.className = 'engine-mark';
      // The mark is a host-provided inline SVG; the CSP forbids remote images,
      // so it is injected as markup rather than referenced.
      mark.innerHTML = engine.logo || '';
      var name = document.createElement('span');
      name.className = 'engine-name';
      name.textContent = engineLabel(engine);
      tab.appendChild(mark);
      tab.appendChild(name);
      host.appendChild(tab);
    }
    syncTabs();
  }

  function syncTabs() {
    var current = field('engine').value;
    var tabs = byId('engine-tabs').querySelectorAll('[data-engine]');
    for (var i = 0; i < tabs.length; i++) {
      var active = tabs[i].getAttribute('data-engine') === current;
      if (active) { tabs[i].classList.add('active'); } else { tabs[i].classList.remove('active'); }
      tabs[i].setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  // Keeps the host-generated default name in sync with the engine, but only
  // while the user has not typed over it.
  function syncAutoName(engine) {
    var name = field('name');
    if (!name || !engine) { return; }
    if (name.value === '' || name.value === autoName) {
      autoName = 'New ' + engineLabel(engine) + ' Connection';
      name.value = autoName;
    }
  }

  function selectEngine(id) {
    var engine = engineById(id);
    if (!engine) { return; }
    field('engine').value = id;
    syncTabs();
    syncAutoName(engine);
    applyEngine();
    applyToggles();
    setFieldErrors({});
  }
`;

const SCRIPT_PART_TWO = `
  function applyEngine() {
    var engine = engineById(field('engine').value);
    var fileBased = !!(engine && engine.fileBased);
    toggleHidden('server-fields', !fileBased);
    toggleHidden('file-fields', fileBased);
    // A file engine has no host, no TLS handshake and no tunnel to open.
    toggleHidden('ssl-section', fileBased);
    toggleHidden('ssh-section', fileBased);
    var sslSection = byId('ssl-section');
    var sshSection = byId('ssh-section');
    if (fileBased && sslSection) { sslSection.open = false; }
    if (fileBased && sshSection) { sshSection.open = false; }
    var sslState = byId('ssl-state');
    if (sslState) { sslState.textContent = field('sslEnabled').checked ? 'on' : ''; }
    var sshState = byId('ssh-state');
    if (sshState) { sshState.textContent = field('sshEnabled').checked ? 'on' : ''; }
    if (!fileBased && engine && engine.defaultPort && field('port') && !field('port').value) {
      field('port').value = String(engine.defaultPort);
      field('port').placeholder = String(engine.defaultPort);
    }
  }

  function applyToggles() {
    var sslOn = field('sslEnabled').checked;
    var sshOn = field('sshEnabled').checked;
    toggleHidden('ssl-advanced', sslOn);
    toggleHidden('ssh-advanced', sshOn);
    // Enabling a feature opens its section once; the user may collapse it again.
    var sslSection = byId('ssl-section');
    var sshSection = byId('ssh-section');
    if (sslSection && sslOn && !sslSection.open) { sslSection.open = true; }
    if (sshSection && sshOn && !sshSection.open) { sshSection.open = true; }
    applySshSupport();
    var auth = field('sshAuthMethod').value;
    var groups = form.querySelectorAll('[data-auth]');
    for (var i = 0; i < groups.length; i++) {
      var wanted = groups[i].getAttribute('data-auth');
      if (wanted === auth) { groups[i].classList.remove('hidden'); } else { groups[i].classList.add('hidden'); }
    }
  }

  // The build ships no SSH transport: the controls stay visible (the settings
  // may exist in a stored profile) but are disabled, with the reason in words.
  function applySshSupport() {
    var notice = byId('ssh-unavailable');
    var fields = byId('ssh-fields');
    var toggle = byId('ssh-section');
    if (!notice || !fields) { return; }
    if (sshSupported) {
      notice.classList.add('hidden');
      fields.disabled = false;
      return;
    }
    notice.classList.remove('hidden');
    fields.disabled = true;
    if (toggle) { toggle.classList.add('hidden'); }
  }

  // Per-field messages, keyed exactly like the draft field names.
  function setFieldErrors(fields) {
    var slots = form.querySelectorAll('[data-error]');
    for (var i = 0; i < slots.length; i++) {
      var slot = slots[i];
      var key = slot.getAttribute('data-error');
      var message = fields && fields[key] ? fields[key] : '';
      slot.textContent = message;
      if (message) {
        slot.removeAttribute('hidden');
      } else {
        slot.setAttribute('hidden', '');
      }
      var control = field(key);
      if (control) {
        if (message) { control.setAttribute('aria-invalid', 'true'); } else { control.removeAttribute('aria-invalid'); }
      }
    }
  }

  // Status is a left-border blockquote panel: bold prefix states the kind in
  // words, the message travels as textContent so server text stays inert.
  function statusPrefix(kind) {
    if (kind === 'ok') { return 'Success!'; }
    if (kind === 'error') { return 'Connection error!'; }
    if (kind === 'busy') { return 'Working...'; }
    return '';
  }

  function setStatus(kind, text) {
    statusEl.textContent = '';
    if (!text) { statusEl.className = 'panel'; return; }
    statusEl.className = 'panel visible ' + kind;
    var prefix = statusPrefix(kind);
    if (prefix) {
      var bold = document.createElement('span');
      bold.className = 'panel__prefix';
      bold.textContent = prefix;
      statusEl.appendChild(bold);
    }
    var label = document.createElement('span');
    label.className = 'panel__text';
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
    if (action === 'connect') { api.postMessage({ type: 'saveAndConnect', draft: readDraft() }); return; }
    if (action === 'test') { api.postMessage({ type: 'test', draft: readDraft() }); return; }
    if (action === 'cancel') { api.postMessage({ type: 'cancel' }); return; }
    var tab = event.target.closest ? event.target.closest('[data-engine]') : undefined;
    if (tab) { selectEngine(tab.getAttribute('data-engine')); }
  });

  // The tab strip is a list of buttons, so Enter and Space must select it too.
  byId('engine-tabs').addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') { return; }
    var tab = event.target.closest ? event.target.closest('[data-engine]') : undefined;
    if (!tab) { return; }
    event.preventDefault();
    selectEngine(tab.getAttribute('data-engine'));
  });

  form.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter') { return; }
    var target = event.target;
    if (!target || !target.getAttribute) { return; }
    if (target.tagName === 'TEXTAREA') { return; }
    // Enter submits the form like the reference clients: save and connect.
    event.preventDefault();
    api.postMessage({ type: 'saveAndConnect', draft: readDraft() });
  });

  form.addEventListener('change', function (event) {
    var target = event.target;
    if (!target || !target.getAttribute) { return; }
    var key = target.getAttribute('data-draft');
    if (key === 'engine') { syncTabs(); applyEngine(); }
    if (key === 'sslEnabled' || key === 'sshEnabled' || key === 'sshAuthMethod') { applyToggles(); }
  });

  // A fresh keystroke clears the message of that field only.
  form.addEventListener('input', function (event) {
    var target = event.target;
    if (!target || !target.getAttribute) { return; }
    var key = target.getAttribute('data-draft');
    if (!key) { return; }
    var slot = form.querySelector('[data-error="' + key + '"]');
    if (slot && !slot.hasAttribute('hidden')) {
      slot.setAttribute('hidden', '');
      slot.textContent = '';
      target.removeAttribute('aria-invalid');
    }
  });

  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || !message.type) { return; }

    if (message.type === 'init') {
      mode = message.mode;
      sshSupported = message.sshSupported === true;
      var title = byId('form-title');
      if (title) { title.textContent = mode === 'create' ? 'Connect to Database Server' : 'Edit Connection'; }
      engines = message.engines || [];
      renderEngineOptions();
      writeDraft(message.draft || {});
      autoName = field('name').value;
      applyEngine();
      applyToggles();
      applyPresence(message.secretPresence);
      setFieldErrors({});
      if (message.statusKind && message.statusMessage) {
        setStatus(message.statusKind, message.statusMessage);
      }
      field('name').focus();
      return;
    }
    if (message.type === 'busy') { setBusy(!!message.busy, message.label); return; }
    if (message.type === 'testResult') { setStatus(message.ok ? 'ok' : 'error', message.message); return; }
    if (message.type === 'error') {
      setFieldErrors(message.fields || {});
      setStatus('error', message.message);
      return;
    }
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
  /** Inline SVG brand mark shown on the engine tab. */
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
  /** False when the build ships no SSH transport; the UI must say so. */
  sshSupported: boolean;
  statusKind?: '' | 'ok' | 'error' | 'busy';
  statusMessage?: string;
}

function createNonce(): string {
  return randomBytes(16).toString('base64');
}

/** Escapes a value interpolated into an HTML attribute. */
function attr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Renders the form shell.
 *
 * The draft, the engine list and the secret-presence flags are **not** embedded
 * here: the webview asks for them by posting `{ type: 'ready' }`, which keeps a
 * single code path for both the initial load and later refreshes.
 */
export function renderConnectionFormHtml(webview: vscode.Webview, assets: ConnectionFormAssets): string {
  const nonce = createNonce();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
    "font-src 'none'",
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
  <link rel="stylesheet" href="${attr(assets.cssUri)}" />
</head>
<body>
${FORM_BODY}
<script nonce="${nonce}">
${script}
</script>
</body>
</html>`;
}
