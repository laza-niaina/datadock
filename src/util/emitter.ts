/**
 * Minimal event emitter.
 *
 * Used where the data layer needs to publish change notifications without
 * importing `vscode`. The `event` signature is structurally compatible with
 * `vscode.Event<T>`, so instances can be handed straight to the editor APIs.
 */

import type { DisposableLike } from '../db/types';

export type EventListener<T> = (event: T) => void;

export interface Event<T> {
  (listener: EventListener<T>): DisposableLike;
}

export class Emitter<T> {
  private readonly listeners = new Set<EventListener<T>>();
  private disposed = false;

  readonly event: Event<T> = (listener: EventListener<T>): DisposableLike => {
    if (this.disposed) {
      return { dispose: () => undefined };
    }
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    if (this.disposed) {
      return;
    }
    // Copy first: a listener may unsubscribe itself or others while running.
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}
