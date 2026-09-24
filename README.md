# DataDock for VS Code

DataDock is a free, open database tooling extension for Visual Studio Code:
explore the structure of your MySQL, MariaDB and SQLite databases, run SQL,
inspect result sets, and browse table data without leaving the editor. Inline
data editing is on the roadmap (see below).

## No paywall, ever

This extension has **no account, no subscription, no premium tier, no trial, no
feature gate, no artificial row/connection quota and no telemetry**. Every
capability described here is available to every user, and you can create as many
connections as your machine and your database server allow.

## Status

This project is under active development. Only what is listed below is
implemented; anything else is on the roadmap and is not advertised as working.

### Implemented

- **Database Explorer** activity-bar view.
- **Connection management**: create, test, edit, duplicate, delete, connect,
  disconnect, reconnect. Unlimited connections.
- **Secrets in the OS keychain** via VS Code `SecretStorage`. Passwords, SSH
  passwords and private keys are never written to settings, logs, exports or
  crash reports.
- **Connection profiles** shared by every engine, with SSL/TLS and SSH tunnel
  settings (SSH tunnelling itself needs the SSH service, see roadmap).
- **Metadata cache** with manual refresh and adjustable lifetime.
- **SQL editor**: every `.sql` document can be associated with a DataDock
  connection (remembered per file, never written into the file itself). Run the
  selected query with **Ctrl+Enter** (or the statement under the cursor when
  nothing is selected) and the whole document with **Ctrl+Shift+Enter**. The
  engine-aware statement splitter handles string literals, comments and MySQL
  `DELIMITER` routines, so a stored procedure body stays one statement. A blank
  line separates two statements only when the first one has no `;`; a plain line
  break never splits a statement. Clickable CodeLens actions sit above every
  statement (run all, run that statement, pick the connection and the active
  database). The status bar shows the file's connection and the active
  engine/database; click either to change them.
- **Rich query results**: per-statement status (ok / error / skipped), columns
  with types, `NULL` highlighting, row counts, affected rows for
  INSERT/UPDATE/DELETE, run times, and an error banner that lets you jump back
  to the exact statement in the SQL file.
- **Table viewer**: open a table or view from the explorer, page through rows,
  search text columns, and sort by column headers.
- **MySQL and MariaDB drivers**: connect, browse databases, tables, views,
  columns (primary keys, auto-increment, defaults, comments) and stored
  procedures/functions, over SSL/TLS if configured.
- **SQLite driver (read-only)**: open any `.db` file, run read-only SQL, and
  browse tables, views, columns and table data. The file is opened in memory as
  a snapshot and is never modified; changes made by other programs appear after
  reconnecting.

### Limitations

- **Table editing is not implemented yet**: the viewer and drivers are read-only
  for row updates, inserts and deletes (`editableData` remains `false`).
- SQLite rejects mutating SQL because the in-memory snapshot is not persisted;
  reconnecting reloads the original file.
- Result pages are capped at 1,000 rows per request; this is a result safety cap,
  not a connection or account limit.
- SQLite is loaded fully into memory; very large files can exhaust memory, and
  the snapshot hides external changes until the profile is reconnected.
- SSH tunnelling is not implemented yet; a profile with SSH enabled fails with a
  clear message instead of connecting in clear text.
- MySQL accounts using `unix_socket` or `auth_gssapi` authentication are not
  supported.

### Roadmap

Drivers are added one at a time, each with its own tests:

1. Table editing: inline updates, inserts and deletes with safe primary-key
   identity handling
2. Query history and richer result export
3. PostgreSQL
4. SQL IntelliSense, snippets and formatter
5. Import / export and backup
6. SSH tunnelling
7. Additional engines

## Getting started

1. Open the **DataDock** view in the activity bar.
2. Click the **+** button to add a connection.
3. Fill in the form and press **Test Connection**, then **Save**.
4. Right-click the connection and choose **Connect**.

### Run SQL and browse data

1. In the DataDock Connections view, click the SQL editor icon or run **DataDock: Open SQL Editor**.
2. **DataDock: Select Connection for SQL File** chooses the connection that will
   be remembered for the current `.sql` file. The active SQL file also shows its
   association and the active engine/database in the status bar; click either to
   change the connection or the database. CodeLens actions above each statement
   do the same.
3. Put the cursor inside a statement and press **Ctrl+Enter** to run it, or select
   several statements to run them as a batch (`Ctrl+Enter` again). Press
   **Ctrl+Shift+Enter** to run every statement in the document in order; the
   batch stops at the first error and the rest are marked as skipped. Statements
   are separated by `;` or, when a statement has no `;`, by a blank line.
4. Click a table or view in the explorer to open the table viewer. Use Previous/Next, Search and column headers to navigate; editing controls appear only after row-editing support is implemented.

## Security

- Credentials are stored with VS Code `SecretStorage`, backed by the operating
  system keychain (Windows Credential Manager, macOS Keychain, libsecret).
- Every log line and error message passes through a redactor that removes known
  secrets and credential-shaped substrings (`password=`, `user:pass@host`,
  PEM blocks, `Authorization:` headers) before they are displayed.
- Nothing is sent anywhere. The extension makes no network request other than
  the ones you explicitly ask for, to the database you configured.

## Requirements

- VS Code 1.85 or newer.

## Development

```bash
npm install
npm run compile      # type-check + bundle to dist/extension.js
npm run watch        # rebuild on change
npm run lint
npm run test:unit    # unit tests, no database server needed
```

Run the extension with the **Run Extension** launch configuration (F5).

## License

MIT.
