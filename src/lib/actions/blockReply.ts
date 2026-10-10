import type { Action } from 'svelte/action';

/**
 * Svelte action that tracks which reply-able block of rendered markdown the
 * pointer is over, so a one-click "reply to this" button can sit in the gutter
 * next to it. Only markdown inside a `[data-block-reply]` subtree counts (the
 * main transcript's assistant text), and the innermost block wins — hovering a
 * nested list item targets that item, not its parent.
 *
 * Event delegation on purpose: the markdown is `{@html}`, so there is nothing to
 * hang per-block handlers on, and it re-renders while streaming.
 *
 * Hiding is debounced so the pointer can cross the gap from the block to the
 * gutter button; anything inside `[data-block-reply-ui]` keeps the block alive.
 */
export interface HoveredBlock {
  el: HTMLElement;
  /** Viewport rect of the block, for anchoring the button. */
  rect: DOMRect;
}

export interface BlockReplyParams {
  /** When false, the action reports nothing. */
  enabled?: boolean;
  onChange: (block: HoveredBlock | null) => void;
}

const BLOCK_SELECTOR =
  'p, li, h1, h2, h3, h4, h5, h6, blockquote, tr, .code-block-wrapper';

const HIDE_DELAY_MS = 200;

export const blockReply: Action<HTMLElement, BlockReplyParams> = (
  node,
  initial
) => {
  let params = initial;
  let current: HTMLElement | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  function cancelHide() {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  }

  function set(el: HTMLElement | null) {
    cancelHide();
    if (el === current) return;
    current = el;
    params.onChange(el ? { el, rect: el.getBoundingClientRect() } : null);
  }

  function scheduleHide() {
    if (!current || hideTimer) return;
    hideTimer = setTimeout(() => {
      hideTimer = undefined;
      set(null);
    }, HIDE_DELAY_MS);
  }

  function handleOver(e: MouseEvent) {
    if (params.enabled === false) return set(null);
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return scheduleHide();
    if (target.closest('[data-block-reply-ui]')) return cancelHide();
    const root = target.closest('[data-block-reply]');
    const block = root ? target.closest<HTMLElement>(BLOCK_SELECTOR) : null;
    if (block && root!.contains(block)) set(block);
    else scheduleHide();
  }

  function handleLeave() {
    scheduleHide();
  }

  /** The block moved under a stationary pointer — drop it, the next hover re-reports. */
  function handleScroll() {
    set(null);
  }

  node.addEventListener('mouseover', handleOver);
  node.addEventListener('mouseleave', handleLeave);
  node.addEventListener('scroll', handleScroll, { capture: true, passive: true });

  return {
    update(next: BlockReplyParams) {
      params = next;
      if (params.enabled === false) set(null);
    },
    destroy() {
      cancelHide();
      node.removeEventListener('mouseover', handleOver);
      node.removeEventListener('mouseleave', handleLeave);
      node.removeEventListener('scroll', handleScroll, true);
      if (current) params.onChange(null);
    },
  };
};

/**
 * The text a block reply quotes: the block's own text, without nested lists
 * (a list item quotes just its line, not its sub-items) and with table cells
 * kept apart. Code blocks quote their code, flagged so it's quoted as code.
 */
export function blockQuoteText(el: HTMLElement): { text: string; isCode: boolean } {
  if (el.matches('.code-block-wrapper')) {
    return { text: el.querySelector('pre code')?.textContent ?? '', isCode: true };
  }
  if (el.matches('tr')) {
    const cells = Array.from(el.children, (cell) => cell.textContent?.trim() ?? '');
    return { text: cells.filter(Boolean).join(' | '), isCode: false };
  }
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('ul, ol, .code-copy-button').forEach((n) => n.remove());
  return { text: clone.textContent ?? '', isCode: false };
}
