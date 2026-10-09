import { readable } from 'svelte/store';

/**
 * Shared wall clock (ms), ticking once a second. One interval for the whole app,
 * and only while something is subscribed — e.g. the elapsed timer on a running
 * tool card — so an idle transcript costs nothing.
 */
export const clock = readable(Date.now(), (set) => {
  set(Date.now());
  const timer = setInterval(() => set(Date.now()), 1000);
  return () => clearInterval(timer);
});
