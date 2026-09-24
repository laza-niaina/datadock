# DataDock for VS Code

DataDock is a free, open database tooling extension for Visual Studio Code:
explore the structure of your MySQL, MariaDB and SQLite databases without
leaving the editor. Query execution and data editing are on the roadmap (see
below).

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
- **MySQL and MariaDB drivers (metadata browsing)**: connect, browse databases,
  tables, views, columns (primary keys, auto-increment, defaults, comments) and
  stored procedures/functions, over SSL/TLS if configured.
- **SQLite driver (metadata browsing, read-only)**: open any `.db` file, browse
  tables, views and columns. The file is opened in memory as a snapshot and is
  never modified; changes made by other programs appear after reconnecting.

### Limitations

- The drivers above are **browse-only**: running SQL statements and viewing or
  editing table data are not implemented yet (`UNSUPPORTED_OPERATION`).
- SQLite is loaded fully into memory; very large files can exhaust memory, and
  the snapshot hides external changes until the profile is reconnected.
- SSH tunnelling is not implemented yet; a profile with SSH enabled fails with a
  clear message instead of connecting in clear text.
- MySQL accounts using `unix_socket` or `auth_gssapi` authentication are not
  supported.

### Roadmap

Drivers are added one at a time, each with its own tests:

1. Query execution: SQL editor, results panel, query history (MySQL/MariaDB,
   SQLite)
2. Table viewer with pagination, sorting, filtering and inline editing
3. PostgreSQL
4. SQL IntelliSense, snippets and formatter
5. Import / export, backup
6. SSH tunnelling
7. Additional engines

## Getting started

1. Open the **DataDock** view in the activity bar.
2. Click the **+** button to add a connection.
3. Fill in the form and press **Test Connection**, then **Save**.
4. Right-click the connection and choose **Connect**.

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
