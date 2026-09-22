/**
 * Safe value rendering for logs and UI.
 * Pure logic: no `vscode` dependency, unit-testable.
 */

const DEFAULT_MAX = 4000;

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…(+${text.length - maxLength} chars)`;
}

/**
 * Renders any value as a single readable line.
 * Circular references are marked instead of throwing, and binary data is
 * summarised so that result grids cannot flood the output channel.
 */
export function safeStringify(value: unknown, maxLength: number = DEFAULT_MAX): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  switch (typeof value) {
    case 'string':
      return truncate(value, maxLength);
    case 'number':
    case 'boolean':
      return String(value);
    case 'bigint':
      return `${value.toString()}n`;
    case 'symbol':
      return value.toString();
    case 'function':
      return `[function ${value.name || 'anonymous'}]`;
    default:
      break;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (value instanceof Error) {
    return truncate(`${value.name}: ${value.message}`, maxLength);
  }
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return `[${value.length} bytes]`;
  }

  const seen = new WeakSet<object>();
  try {
    const json = JSON.stringify(
      value,
      (_key, nested: unknown) => {
        if (typeof nested === 'bigint') {
          return `${nested.toString()}n`;
        }
        if (nested instanceof Date) {
          return nested.toISOString();
        }
        if (nested instanceof Error) {
          return `${nested.name}: ${nested.message}`;
        }
        if (nested instanceof Uint8Array || Buffer.isBuffer(nested)) {
          return `[${nested.length} bytes]`;
        }
        if (typeof nested === 'object' && nested !== null) {
          if (seen.has(nested)) {
            return '[Circular]';
          }
          seen.add(nested);
        }
        return nested;
      },
      2,
    );
    return truncate(json ?? String(value), maxLength);
  } catch {
    return truncate(Object.prototype.toString.call(value), maxLength);
  }
}

/**
 * Renders a database cell value for display.
 * `null` and `undefined` are kept distinguishable because the table viewer
 * shows SQL `NULL` differently from an empty string.
 */
export function displayCell(value: unknown): string {
  if (value === null) return 'NULL';
  if (value === undefined) return '';
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return `<${value.length} bytes>`;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    return safeStringify(value, 500);
  }
  return String(value);
}
