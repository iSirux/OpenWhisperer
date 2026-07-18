<script lang="ts">
  import { onMount } from "svelte";
  import {
    holdSpaceRecord,
    type HoldSpaceRecordParams,
  } from "$lib/actions/holdSpaceRecord";
  import {
    getImagesFromClipboard,
    getImagesFromClipboardHtml,
  } from "$lib/utils/image";

  let {
    value = $bindable(""),
    placeholder = "",
    rows = 1,
    maxHeight = 200,
    variant = "session",
    holdSpace = undefined,
    onImageFiles = undefined,
    oninput = undefined,
    onkeydown = undefined,
  }: {
    value?: string;
    placeholder?: string;
    rows?: number;
    /** Max auto-resize height in px before the textarea scrolls internally. */
    maxHeight?: number;
    /** Visual variant: 'session' reserves right padding for the inline mic
     *  button (SdkPromptInput); 'setup' is the New Session form look. */
    variant?: "session" | "setup";
    /** Passed through to the holdSpaceRecord action (hold-Space dictation/sends). */
    holdSpace?: HoldSpaceRecordParams;
    /** Receives pasted image files (raw blobs or images embedded in pasted HTML). */
    onImageFiles?: (files: File[]) => void | Promise<void>;
    oninput?: () => void;
    onkeydown?: (e: KeyboardEvent) => void;
  } = $props();

  let textareaEl: HTMLTextAreaElement;

  export function focus() {
    textareaEl?.focus();
  }

  function autoResize() {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
    const newHeight = Math.min(textareaEl.scrollHeight, maxHeight);
    textareaEl.style.height = newHeight + "px";
    textareaEl.style.overflowY =
      textareaEl.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  $effect(() => {
    value;
    autoResize();
  });

  // On (re)mount the textarea often carries a restored multi-line draft. The
  // $effect above resizes synchronously, but the textarea isn't laid out at its
  // final width yet (pane/layout sizing settles after mount), so scrollHeight
  // reads as a single row. Resize again after the first paint.
  onMount(() => {
    requestAnimationFrame(autoResize);
  });

  async function handlePaste(e: ClipboardEvent) {
    if (!onImageFiles) return;
    // Read clipboard data synchronously — it's only valid during the event.
    const html = e.clipboardData?.getData("text/html") ?? "";
    const imageFiles = await getImagesFromClipboard(e);
    if (imageFiles.length > 0) {
      // Raw image blob (e.g. a screenshot) — replace the paste with the image.
      e.preventDefault();
      await onImageFiles(imageFiles);
      return;
    }
    // Rich HTML with embedded images (e.g. a page copied from Google Docs).
    // Don't preventDefault — let the accompanying text paste normally, and
    // attach the images alongside it.
    const htmlImages = await getImagesFromClipboardHtml(html);
    if (htmlImages.length > 0) {
      await onImageFiles(htmlImages);
    }
  }
</script>

<textarea
  bind:this={textareaEl}
  bind:value
  class={variant}
  {rows}
  {placeholder}
  oninput={() => {
    autoResize();
    oninput?.();
  }}
  {onkeydown}
  onpaste={handlePaste}
  use:holdSpaceRecord={holdSpace ?? {
    enabled: false,
    start: () => {},
    stop: async () => null,
  }}
></textarea>

<style>
  textarea {
    display: block;
    width: 100%;
    background: var(--color-surface);
    color: var(--color-text-primary);
    border: 1px solid var(--color-border);
    resize: none;
    font-family: inherit;
    font-size: 0.9rem;
    min-height: unset;
    overflow-y: hidden;
    scrollbar-width: none;
    -ms-overflow-style: none;
    box-sizing: border-box;
  }

  textarea::-webkit-scrollbar {
    display: none;
  }

  textarea:focus {
    outline: none;
    border-color: var(--color-accent);
  }

  textarea:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  textarea::placeholder {
    color: var(--color-text-muted);
  }

  textarea.session {
    border-radius: 6px;
    padding: 0.75rem 2.5rem 0.75rem 0.75rem;
    line-height: 1.4;
  }

  textarea.setup {
    border-radius: 0.5rem;
    padding: 0.875rem 1rem;
    line-height: 1.5;
    transition: border-color 0.15s ease;
  }
</style>
