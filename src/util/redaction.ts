/**
 * Credential redaction.
 *
 * Every string that reaches a log, an error notification, an export or a
 * webview must pass through a `Redactor` first. Two complementary strategies
 * are used:
 *
 *  1. **Known-value redaction** - passwords actually typed by the user are
 *     registered and replaced verbatim wherever they appear, including inside
 *     driver error messages.
 *  2. **Pattern redaction** - credential-shaped substrings (URI userinfo,
 *     `password=`, SQL `IDENTIFIED BY`, `Authorization:` headers, PEM blocks)
 *     are masked even when the value was never registered, e.g. because it
 *     came from a connection string embedded in user SQL.
 */

export const MASK = '***';

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // scheme://user:password@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@/]+)@/gi, `$1:${MASK}@`],
  // PEM material
  [PRIVATE_KEY_BLOCK, `-----BEGIN PRIVATE KEY-----${MASK}-----END PRIVATE KEY-----`],
  // key=value / key: value
  [
    /(\b(?:password|passwd|pwd|pass|secret|token|apikey|api_key|accesskey|access_key)\b\s*[=:]\s*)(["']?)([^\s,;"')\]}&]+)(\2)/gi,
    `$1$2${MASK}$4`,
  ],
  // SQL: ... IDENTIFIED BY 'secret'
  [/(\bIDENTIFIED\s+BY\s+)(["'])([\s\S]*?)\2/gi, `$1$2${MASK}$2`],
  // SQL: ... PASSWORD 'secret'
  [/(\bPASSWORD\s+)(["'])([\s\S]*?)\2/gi, `$1$2${MASK}$2`],
  // HTTP style header - the scheme (Bearer, Basic…) carries no secret but is
  // masked too: over-masking is safe, under-masking is not.
  [/(\bAuthorization\s*:\s*)\S[^\n]*/gi, `$1${MASK}`],
  // libpq / mysql style URI parameters
  [/([?&](?:password|pwd)=)([^&\s]*)/gi, `$1${MASK}`],
];

/** Keys whose values are masked entirely rather than pattern-scanned. */
const SENSITIVE_KEY = /(password|passwd|pwd|secret|token|privatekey|passphrase|credential)/i;

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replaces credential-shaped substrings without knowing the actual values. */
export function redactPatterns(text: string): string {
  let output = text;
  for (const [pattern, replacement] of PATTERNS) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, replacement);
  }
  return output;
}

export class Redactor {
  private readonly secrets = new Set<string>();

  /**
   * Registers a literal secret to be masked verbatim.
   * Very short values (< 3 chars) are ignored: masking them would destroy
   * unrelated text and they carry no meaningful entropy.
   */
  addSecret(value: string | undefined | null): void {
    if (typeof value !== 'string') {
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length >= 3) {
      this.secrets.add(trimmed);
    }
  }

  addSecrets(values: Iterable<string | undefined | null>): void {
    for (const value of values) {
      this.addSecret(value);
    }
  }

  /** Removes every registered literal secret (used when a profile is deleted). */
  clear(): void {
    this.secrets.clear();
  }

  /**
   * Forgets one literal secret.
   * Called when a connection profile is deleted: leaving it registered would
   * keep masking an unrelated substring in later log output.
   */
  deleteSecret(value: string | undefined | null): boolean {
    if (typeof value !== 'string') {
      return false;
    }
    return this.secrets.delete(value.trim());
  }
  /** Number of registered literal secrets; exposed for tests and diagnostics. */
  get size(): number {
    return this.secrets.size;
  }

  redact(text: string): string {
    let output = text;
    // Longest first so that a secret containing another secret is masked whole.
    const ordered = [...this.secrets].sort((a, b) => b.length - a.length);
    for (const secret of ordered) {
      if (output.includes(secret)) {
        output = output.split(secret).join(MASK);
      }
    }
    return redactPatterns(output);
  }

  /**
   * Recursively redacts any value. Sensitive object keys are masked wholesale;
   * everything else is scanned with `redact`.
   */
  redactDeep<T>(value: T): T {
    return this.walk(value, 0, new WeakSet<object>()) as T;
  }

  /**
   * `ancestors` holds the objects on the current path, so a circular structure
   * is masked instead of recursing until the depth cap.
   */
  private walk(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
    if (depth > 8) {
      return MASK;
    }
    if (typeof value === 'string') {
      return this.redact(value);
    }
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (value instanceof Date || value instanceof Uint8Array || Buffer.isBuffer(value)) {
      return value;
    }
    if (value instanceof Error) {
      return this.redact(value.message);
    }
    if (ancestors.has(value)) {
      return MASK;
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((entry) => this.walk(entry, depth + 1, ancestors));
      }
      const source = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(source)) {
        result[key] = SENSITIVE_KEY.test(key) ? MASK : this.walk(source[key], depth + 1, ancestors);
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  }
}

/**
 * Process-wide redactor. The extension registers every password/private key it
 * loads so that log output and error notifications are safe by construction.
 */
export const globalRedactor = new Redactor();
