import { get, writable, type Updater, type Writable } from 'svelte/store';

/**
 * A writable whose hot-path updates can be coalesced.
 *
 * `queue(fn)` defers an updater; every updater queued before the next frame is applied, in
 * arrival order, as ONE store write — so subscribers are woken once per frame instead of
 * once per event. This is for high-frequency event streams (the SDK sidecar can emit dozens of
 * text/tool/usage events per frame across a dozen sessions, and every notification fans out to
 * the sidebar, headers, panes and derived stores).
 *
 * Read-your-writes holds: `subscribe` (and therefore `get()`), `update` and `set` flush the
 * pending queue synchronously first, so any reader or direct writer observes every queued
 * change, and a direct write lands after all earlier queued ones.
 *
 * The flush is scheduled with requestAnimationFrame AND a setTimeout fallback, whichever fires
 * first: rAF doesn't run while the window is hidden / minimized to tray, and the store must keep
 * advancing there (completion handling, Smart Queue dispatch).
 */
export interface BatchedWritable<T> extends Writable<T> {
  /** Defer an updater to the next batched flush (applied in arrival order). */
  queue(fn: Updater<T>): void;
  /** Apply all queued updaters now, as one store write. No-op when nothing is queued. */
  flush(): void;
}

export interface BatchedWritableOptions {
  /** Fallback flush delay for when rAF is unavailable or throttled (hidden window). */
  fallbackMs?: number;
}

export function batchedWritable<T>(initial: T, options: BatchedWritableOptions = {}): BatchedWritable<T> {
  const fallbackMs = options.fallbackMs ?? 50;
  const inner = writable<T>(initial);
  let pending: Updater<T>[] = [];
  let rafHandle: number | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  // True only while queued updaters run. An updater that reads the store (get → subscribe)
  // must not start a nested flush whose write the outer one would then overwrite; anything
  // queued meanwhile stays pending (queue() already scheduled it). Subscribers notified by the
  // write itself run after this is cleared, so they can flush/write normally.
  let computing = false;

  function cancelScheduled(): void {
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  }

  function schedule(): void {
    if (rafHandle !== null || timeoutHandle !== null) return;
    if (typeof requestAnimationFrame === 'function') {
      rafHandle = requestAnimationFrame(() => {
        rafHandle = null;
        flush();
      });
    }
    timeoutHandle = setTimeout(() => {
      timeoutHandle = null;
      flush();
    }, fallbackMs);
  }

  function flush(): void {
    if (computing) return;
    cancelScheduled();
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    // The live value, not a mirror: a mirror subscriber can lag behind nested writes that are
    // still working through Svelte's notification queue.
    const value = get(inner);
    let next = value;
    computing = true;
    try {
      for (const fn of batch) {
        // One faulty updater must not drop the rest of the batch (unbatched, each would have
        // failed on its own).
        try {
          next = fn(next);
        } catch (err) {
          console.error('[batchedWritable] queued updater failed:', err);
        }
      }
    } finally {
      computing = false;
    }
    // A batch of pure no-ops (every updater returned its input) wakes nobody.
    if (next !== value) inner.set(next);
  }

  return {
    subscribe(run, invalidate) {
      flush();
      return inner.subscribe(run, invalidate);
    },
    update(fn) {
      flush();
      inner.update(fn);
    },
    set(value) {
      flush();
      inner.set(value);
    },
    queue(fn) {
      pending.push(fn);
      schedule();
    },
    flush,
  };
}
