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
 * The hit area is generous: the margins between blocks snap to the nearest
 * block, and the gutter left of the text column (where the button sits) counts
 * as hovering the block beside it — so the pointer never has to land on the
 * glyphs themselves. Tracking is on `mousemove` (rAF-throttled), since moving
 * from a paragraph into its parent's margin or the gutter fires no `mouseover`.
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
  /** Ctrl/Cmd+click on (or beside) a block. Without it, the click passes through. */
  onCtrlClick?: (el: HTMLElement) => void;
}

const BLOCK_SELECTOR =
  'p, li, h1, h2, h3, h4, h5, h6, blockquote, tr, .code-block-wrapper';

const ROOT_SELECTOR = '[data-block-reply]';

const HIDE_DELAY_MS = 200;

/** How far left of the text column the pointer still targets a block (covers the button). */
const GUTTER_PX = 28;

/**
 * The block in `root` nearest to viewport `y`: one containing it, else the
 * closest above/below (the pointer is in a margin). Among blocks containing it
 * the last in document order wins — that's the innermost, since a nested block
 * always follows its ancestor.
 */
function nearestBlock(root: Element, y: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestDist = Infinity;
  for (const el of root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)) {
    const r = el.getBoundingClientRect();
    if (r.height === 0) continue;
    const dist = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (dist < bestDist || (dist === 0 && bestDist === 0)) {
      best = el;
      bestDist = dist;
    }
  }
  return best;
}

/** The reply-able block the pointer at (`x`, `y`) over `target` targets, if any. */
function blockAt(x: number, y: number, target: Element): HTMLElement | null {
  // Directly on a leaf block: that's the one. A block with nested blocks (a
  // list item with a sub-list) falls through to the by-row lookup — the
  // pointer may be in its indent, crossing toward the gutter from a sub-item.
  let root = target.closest(ROOT_SELECTOR);
  const direct = root ? target.closest<HTMLElement>(BLOCK_SELECTOR) : null;
  if (direct && root!.contains(direct) && !direct.querySelector(BLOCK_SELECTOR)) {
    return direct;
  }

  // In the gutter left of the text column: probe across it for a root.
  if (!root) {
    const probe = document.elementFromPoint(x + GUTTER_PX, y);
    root = probe?.closest(ROOT_SELECTOR) ?? null;
  }
  // Otherwise pick by row only (x ignored): the innermost block at this
  // height, or the nearest one when in a margin.
  return root ? nearestBlock(root, y) : null;
}

export const blockReply: Action<HTMLElement, BlockReplyParams> = (
  node,
  initial
) => {
  let params = initial;
  let current: HTMLElement | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  let pointer: { x: number; y: number; target: EventTarget | null } | null = null;

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

  function track() {
    frame = 0;
    if (!pointer) return;
    if (params.enabled === false) return set(null);
    const target = pointer.target instanceof Element ? pointer.target : null;
    if (target?.closest('[data-block-reply-ui]')) return cancelHide();
    const block = target ? blockAt(pointer.x, pointer.y, target) : null;
    if (block) set(block);
    else scheduleHide();
  }

  function handleMove(e: MouseEvent) {
    pointer = { x: e.clientX, y: e.clientY, target: e.target };
    if (!frame) frame = requestAnimationFrame(track);
  }

  /** Ctrl/Cmd+click anywhere the hover would target replies to that block. */
  function handleClick(e: MouseEvent) {
    if (!params.onCtrlClick || params.enabled === false) return;
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    const target = e.target instanceof Element ? e.target : null;
    // Links and controls keep their own Ctrl+click.
    if (!target || target.closest('a, button, input, textarea, select, [data-block-reply-ui]')) {
      return;
    }
    const block = blockAt(e.clientX, e.clientY, target);
    if (!block) return;
    e.preventDefault();
    params.onCtrlClick(block);
  }

  function handleLeave() {
    pointer = null;
    scheduleHide();
  }

  /** The block moved under a stationary pointer — drop it, the next move re-reports. */
  function handleScroll() {
    set(null);
  }

  node.addEventListener('mousemove', handleMove, { passive: true });
  node.addEventListener('mouseleave', handleLeave);
  node.addEventListener('click', handleClick);
  node.addEventListener('scroll', handleScroll, { capture: true, passive: true });

  return {
    update(next: BlockReplyParams) {
      params = next;
      if (params.enabled === false) set(null);
    },
    destroy() {
      cancelHide();
      cancelAnimationFrame(frame);
      node.removeEventListener('mousemove', handleMove);
      node.removeEventListener('mouseleave', handleLeave);
      node.removeEventListener('click', handleClick);
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
