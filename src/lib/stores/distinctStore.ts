import { readable, type Readable } from 'svelte/store';

/** Same own keys with `===` values (one level deep). */
export function shallowEqual<T extends object>(a: T, b: T): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a) as (keyof T)[];
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * Wrap `source` so subscribers are only notified when the value actually changes per `equals`
 * (default `===`). Svelte's own stores treat every object as changed on each write, so a
 * derived that picks one session out of the sessions array would otherwise re-fire on every
 * streaming event from ANY session.
 *
 * Built as a `readable` (not a filtering `subscribe` wrapper) so a downstream `derived` gets a
 * proper invalidate/run pair — skipping `run` after forwarding `invalidate` would leave it
 * stuck pending.
 */
export function distinctStore<T>(
  source: Readable<T>,
  initial: T,
  equals: (a: T, b: T) => boolean = (a, b) => a === b
): Readable<T> {
  return readable<T>(initial, set => {
    let first = true;
    let last: T = initial;
    return source.subscribe(value => {
      if (!first && equals(last, value)) return;
      first = false;
      last = value;
      set(value);
    });
  });
}
