<script lang="ts">
  import { onDestroy } from "svelte";
  import type { SdkImageContent } from "$lib/stores/sdkSessions";
  import {
    getImagesFromClipboard,
    getImagesFromClipboardHtml,
    getImagesFromDrop,
    processImages,
    createPreviewUrl,
    formatFileSize,
    type ImageData,
  } from "$lib/utils/image";
  import { nextWindowResetAt, type QueueWindow } from "$lib/stores/queueDetection";
  import { rateLimitData, codexRateLimitData } from "$lib/stores/rateLimits";
  import type { SdkProvider } from "$lib/utils/models";
  import { settings } from "$lib/stores/settings";
  import { holdSpaceRecord } from "$lib/actions/holdSpaceRecord";

  let {
    sessionId,
    isQuerying = false,
    isRecording = false,
    isTranscribing = false,
    isRecordingForCurrentSession = false,
    isInlineRecording = false,
    isInlineTranscribing = false,
    draftPrompt = "",
    draftImages = [],
    provider = "claude",
    showScheduleSend = false,
    onSendPrompt,
    onScheduleSend,
    onStopQuery,
    onStartRecording,
    onStopRecording,
    onStartInlineRecording,
    onStopInlineRecording,
    onInlineTranscribe,
    onDraftChange,
  }: {
    sessionId: string;
    isQuerying?: boolean;
    isRecording?: boolean;
    isTranscribing?: boolean;
    isRecordingForCurrentSession?: boolean;
    isInlineRecording?: boolean;
    isInlineTranscribing?: boolean;
    draftPrompt?: string;
    draftImages?: SdkImageContent[];
    /** Provider of the current session, used to label the "send on next reset" countdowns. */
    provider?: SdkProvider;
    /** Whether to expose the "send on next reset" dropdown (only for live/active sessions). */
    showScheduleSend?: boolean;
    onSendPrompt: (prompt: string, images?: SdkImageContent[]) => void;
    /** Defer this turn to the next window boundary instead of sending it now. */
    onScheduleSend?: (
      window: QueueWindow,
      prompt: string,
      images?: SdkImageContent[],
    ) => void;
    onStopQuery: () => void;
    onStartRecording: () => void;
    onStopRecording: () => void;
    onStartInlineRecording: () => void;
    onStopInlineRecording: () => void;
    /** Stop the inline recording and return the transcript (for hold-Space, which inserts at the caret). */
    onInlineTranscribe?: () => Promise<string | null>;
    onDraftChange?: (
      sessionId: string,
      prompt: string,
      images: SdkImageContent[],
    ) => void;
  } = $props();

  const holdSpaceHint = $derived(
    $settings.audio.hold_space_to_record_inline
      ? ", hold Space to dictate, +Shift to send"
      : ""
  );

  // Local state for immediate responsiveness, synced from props
  let prompt = $state(draftPrompt);
  let pendingImages = $state<ImageData[]>(
    // Convert SdkImageContent to ImageData format for display
    draftImages.map((img) => ({
      mediaType: img.mediaType,
      base64Data: img.base64Data,
      width: img.width ?? 0,
      height: img.height ?? 0,
      originalSize: 0,
      compressedSize: 0,
    }))
  );

  // Track session ID to detect session switches (not draft content)
  let prevSessionId = $state(sessionId);
  let prevDraftPrompt = $state(draftPrompt);
  let prevDraftImagesKey = $state(JSON.stringify(draftImages));

  // Notify parent of draft changes (debounced to avoid too many updates)
  let draftChangeTimeout: ReturnType<typeof setTimeout> | null = null;

  function getImageContent(): SdkImageContent[] {
    return pendingImages.map((img) => ({
      mediaType: img.mediaType,
      base64Data: img.base64Data,
      width: img.width,
      height: img.height,
    }));
  }

  function applyDraftPropsToLocalState() {
    prompt = draftPrompt;
    pendingImages = draftImages.map((img) => ({
      mediaType: img.mediaType,
      base64Data: img.base64Data,
      width: img.width ?? 0,
      height: img.height ?? 0,
      originalSize: 0,
      compressedSize: 0,
    }));
  }

  function emitDraftChange(
    targetSessionId: string,
    targetPrompt: string,
    targetImages: SdkImageContent[],
  ) {
    onDraftChange?.(targetSessionId, targetPrompt, targetImages);
  }

  function flushDraftChange(targetSessionId = prevSessionId) {
    if (!onDraftChange) return;
    if (draftChangeTimeout) {
      clearTimeout(draftChangeTimeout);
      draftChangeTimeout = null;
    }
    emitDraftChange(targetSessionId, prompt, getImageContent());
  }

  function notifyDraftChange() {
    if (!onDraftChange) return;
    if (draftChangeTimeout) clearTimeout(draftChangeTimeout);
    const targetSessionId = prevSessionId;
    const targetPrompt = prompt;
    const targetImages = getImageContent();
    draftChangeTimeout = setTimeout(() => {
      draftChangeTimeout = null;
      emitDraftChange(targetSessionId, targetPrompt, targetImages);
    }, 300);
  }

  // Reset local state ONLY when session ID changes (actual session switch)
  // This prevents resetting when tool calls update the session store
  $effect(() => {
    const draftImagesKey = JSON.stringify(draftImages);

    if (sessionId !== prevSessionId) {
      flushDraftChange(prevSessionId);

      // Update to the new session's values
      applyDraftPropsToLocalState();
      prevSessionId = sessionId;
      prevDraftPrompt = draftPrompt;
      prevDraftImagesKey = draftImagesKey;
      return;
    }

    // Same session: apply incoming draft updates only when they changed AND
    // local state still matches the previous props (avoid clobbering active typing).
    const draftPropsChanged =
      draftPrompt !== prevDraftPrompt || draftImagesKey !== prevDraftImagesKey;

    if (draftPropsChanged) {
      const localMatchesPreviousProps =
        prompt === prevDraftPrompt &&
        JSON.stringify(getImageContent()) === prevDraftImagesKey;

      if (localMatchesPreviousProps) {
        applyDraftPropsToLocalState();
      }

      prevDraftPrompt = draftPrompt;
      prevDraftImagesKey = draftImagesKey;
    }
  });
  let isProcessingImages = $state(false);
  let textareaEl: HTMLTextAreaElement;

  // Expose focus function for external use
  export function focus() {
    textareaEl?.focus();
  }

  // Expose method to imperatively clear the input (e.g. after voice sends that bypass the UI)
  export function clearInput() {
    if (draftChangeTimeout) {
      clearTimeout(draftChangeTimeout);
      draftChangeTimeout = null;
    }
    prompt = "";
    pendingImages = [];
    // Keep prevDraft in sync so the $effect guard doesn't re-apply stale store values
    prevDraftPrompt = "";
    prevDraftImagesKey = "[]";
    emitDraftChange(prevSessionId, "", []);
  }

  // Expose method to get current draft values (for flushing before session switch)
  export function getCurrentDraft(): { prompt: string; images: SdkImageContent[] } {
    // Clear any pending debounced save since we're returning the values now
    if (draftChangeTimeout) {
      clearTimeout(draftChangeTimeout);
      draftChangeTimeout = null;
    }
    return {
      prompt,
      images: pendingImages.map((img) => ({
        mediaType: img.mediaType,
        base64Data: img.base64Data,
        width: img.width,
        height: img.height,
      })),
    };
  }

  onDestroy(() => {
    flushDraftChange(prevSessionId);
  });

  // Expose method to append transcribed text to the current prompt
  export function appendToPrompt(text: string) {
    if (!text.trim()) return;
    prompt = prompt.trim() ? `${prompt.trim()} ${text.trim()}` : text.trim();
    autoResize();
    notifyDraftChange();
    textareaEl?.focus();
  }

  async function handleSendPrompt() {
    if (!prompt.trim() && pendingImages.length === 0) return;

    const currentPrompt = prompt;
    const currentImages =
      pendingImages.length > 0 ? [...pendingImages] : undefined;

    const imageContent: SdkImageContent[] | undefined = currentImages?.map(
      (img) => ({
        mediaType: img.mediaType,
        base64Data: img.base64Data,
        width: img.width,
        height: img.height,
      })
    );

    // Cancel any pending debounced draft change to prevent restoring stale text
    if (draftChangeTimeout) {
      clearTimeout(draftChangeTimeout);
      draftChangeTimeout = null;
    }

    prompt = "";
    pendingImages = [];
    // Keep prevDraft in sync so the $effect guard doesn't re-apply stale store values
    prevDraftPrompt = "";
    prevDraftImagesKey = "[]";
    // Clear draft in parent store
    emitDraftChange(prevSessionId, "", []);
    onSendPrompt(currentPrompt, imageContent);
  }

  // --- Send on next reset (Smart Queue) ---
  let scheduleMenuOpen = $state(false);

  // Live countdown tick — only runs while the schedule menu is open.
  let nowTick = $state(Date.now());
  $effect(() => {
    if (!scheduleMenuOpen) return;
    nowTick = Date.now();
    const t = setInterval(() => {
      nowTick = Date.now();
    }, 1000);
    return () => clearInterval(t);
  });

  let scheduleProvider = $derived(provider ?? "claude");
  // Re-read the reset times whenever the provider's rate-limit store updates.
  let providerRateData = $derived(
    scheduleProvider === "openai" ? $codexRateLimitData : $rateLimitData,
  );
  let reset5hMs = $derived.by(() => {
    void providerRateData;
    return nextWindowResetAt(scheduleProvider, "5h");
  });
  let reset7dMs = $derived.by(() => {
    void providerRateData;
    return nextWindowResetAt(scheduleProvider, "7d");
  });

  function formatCountdown(ms: number | undefined): string {
    if (ms == null) return "";
    const diff = ms - nowTick;
    if (diff <= 0) return "now";
    const days = Math.floor(diff / 86_400_000);
    const hours = Math.floor((diff % 86_400_000) / 3_600_000);
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  let countdown5h = $derived(formatCountdown(reset5hMs));
  let countdown7d = $derived(formatCountdown(reset7dMs));

  let hasDraft = $derived(prompt.trim().length > 0 || pendingImages.length > 0);
  // The caret is always shown for a schedulable (live) session; it's just
  // disabled when it can't be acted on rather than hidden.
  let showScheduleCaret = $derived(showScheduleSend && !!onScheduleSend);
  // The dropdown can only be acted on for a live session that can take a
  // follow-up turn: not while querying/recording, and only with a draft.
  let canScheduleSend = $derived(
    showScheduleCaret &&
      !isQuerying &&
      !isRecording &&
      !isTranscribing &&
      hasDraft,
  );

  $effect(() => {
    // Auto-close the menu if it can no longer be shown (e.g. draft cleared).
    if (scheduleMenuOpen && !canScheduleSend) scheduleMenuOpen = false;
  });

  function handleScheduleSend(window: QueueWindow) {
    scheduleMenuOpen = false;
    if (!onScheduleSend) return;
    if (!prompt.trim() && pendingImages.length === 0) return;

    const currentPrompt = prompt;
    const currentImages =
      pendingImages.length > 0 ? [...pendingImages] : undefined;
    const imageContent: SdkImageContent[] | undefined = currentImages?.map(
      (img) => ({
        mediaType: img.mediaType,
        base64Data: img.base64Data,
        width: img.width,
        height: img.height,
      }),
    );

    // Clear the draft exactly like a normal send.
    if (draftChangeTimeout) {
      clearTimeout(draftChangeTimeout);
      draftChangeTimeout = null;
    }
    prompt = "";
    pendingImages = [];
    prevDraftPrompt = "";
    prevDraftImagesKey = "[]";
    emitDraftChange(prevSessionId, "", []);
    onScheduleSend(window, currentPrompt, imageContent);
  }

  async function handlePaste(e: ClipboardEvent) {
    // Read clipboard data synchronously — it's only valid during the event.
    const html = e.clipboardData?.getData("text/html") ?? "";
    const imageFiles = await getImagesFromClipboard(e);
    if (imageFiles.length > 0) {
      // Raw image blob (e.g. a screenshot) — replace the paste with the image.
      e.preventDefault();
      await addImages(imageFiles);
      return;
    }
    // Rich HTML with embedded images (e.g. a page copied from Google Docs).
    // Don't preventDefault — let the accompanying text paste normally, and
    // attach the images alongside it.
    const htmlImages = await getImagesFromClipboardHtml(html);
    if (htmlImages.length > 0) {
      await addImages(htmlImages);
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.dataTransfer!.dropEffect = "copy";
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    const imageFiles = getImagesFromDrop(e);
    if (imageFiles.length > 0) {
      await addImages(imageFiles);
    }
  }

  async function addImages(files: File[]) {
    if (isProcessingImages) return;
    isProcessingImages = true;
    try {
      const processed = await processImages(files);
      pendingImages = [...pendingImages, ...processed];
      notifyDraftChange();
    } catch (err) {
      console.error("[SdkPromptInput] Error processing images:", err);
    } finally {
      isProcessingImages = false;
    }
  }

  function removeImage(index: number) {
    pendingImages = pendingImages.filter((_, i) => i !== index);
    notifyDraftChange();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendPrompt();
    }
  }

  function autoResize() {
    if (textareaEl) {
      textareaEl.style.height = "auto";
      const maxHeight = 200;
      const newHeight = Math.min(textareaEl.scrollHeight, maxHeight);
      textareaEl.style.height = newHeight + "px";
      textareaEl.style.overflowY =
        textareaEl.scrollHeight > maxHeight ? "auto" : "hidden";
    }
  }

  $effect(() => {
    prompt;
    autoResize();
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="input-area" ondragover={handleDragOver} ondrop={handleDrop}>
  {#if pendingImages.length > 0 || isProcessingImages}
    <div class="pending-images">
      {#each pendingImages as img, i}
        <div class="pending-image">
          <img src={createPreviewUrl(img)} alt="Pending" />
          <button
            class="remove-image"
            onclick={() => removeImage(i)}
            title="Remove image"
          >
            <svg viewBox="0 0 20 20" fill="currentColor">
              <path
                fill-rule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clip-rule="evenodd"
              />
            </svg>
          </button>
          <span class="image-size">{formatFileSize(img.compressedSize)}</span>
        </div>
      {/each}
      {#if isProcessingImages}
        <div class="pending-image processing">
          <div class="processing-spinner"></div>
        </div>
      {/if}
    </div>
  {/if}
  <div class="textarea-wrapper">
    <textarea
      bind:this={textareaEl}
      bind:value={prompt}
      oninput={() => { autoResize(); notifyDraftChange(); }}
      onkeydown={handleKeydown}
      onpaste={handlePaste}
      use:holdSpaceRecord={{
        enabled: $settings.audio.hold_space_to_record_inline,
        // Note: no isQuerying guard — like the mic button, dictating while the
        // agent works is fine (the transcript lands in the prompt, not sent).
        canStart: () =>
          !isRecording &&
          !isTranscribing &&
          !isInlineRecording &&
          !isInlineTranscribing,
        start: onStartInlineRecording,
        stop: () => onInlineTranscribe?.() ?? Promise.resolve(null),
        // Shift+Space: record-and-send immediately (the mic-button flow)
        // instead of inserting the transcript into the prompt.
        shift: {
          canStart: () =>
            !isRecording &&
            !isTranscribing &&
            !isInlineRecording &&
            !isInlineTranscribing,
          start: onStartRecording,
          stop: onStopRecording,
        },
      }}
      placeholder={pendingImages.length > 0
        ? `Add a message about the image(s)... (Enter to send${holdSpaceHint})`
        : `Enter your prompt... (Ctrl+V to paste images, Enter to send${holdSpaceHint})`}
      rows="1"
    ></textarea>
    {#if isInlineTranscribing}
      <button
        class="inline-record-btn transcribing"
        disabled
        title="Transcribing..."
      >
        <div class="inline-transcribing-spinner"></div>
        <svg class="inline-mic-icon" fill="currentColor" viewBox="0 0 20 20">
          <path
            fill-rule="evenodd"
            d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z"
            clip-rule="evenodd"
          />
        </svg>
      </button>
    {:else if isInlineRecording}
      <button
        class="inline-record-btn recording"
        onclick={onStopInlineRecording}
        title="Stop and append to prompt"
      >
        <svg class="inline-mic-icon" fill="currentColor" viewBox="0 0 20 20">
          <path
            fill-rule="evenodd"
            d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z"
            clip-rule="evenodd"
          />
        </svg>
      </button>
    {:else if !isRecording && !isTranscribing}
      <button
        class="inline-record-btn"
        onclick={onStartInlineRecording}
        title="Record and append to prompt"
      >
        <svg class="inline-mic-icon" fill="currentColor" viewBox="0 0 20 20">
          <path
            fill-rule="evenodd"
            d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z"
            clip-rule="evenodd"
          />
        </svg>
      </button>
    {/if}
  </div>
  <div class="button-group">
    {#if isQuerying}
      <button
        onclick={onStopQuery}
        class="stop-button"
        title="Stop current query"
      >
        <svg class="stop-icon" viewBox="0 0 24 24" fill="currentColor">
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      </button>
    {/if}
    {#if isTranscribing}
      <button
        class="record-button transcribing"
        disabled
        title="Transcribing audio..."
      >
        <div class="transcribing-spinner"></div>
        <svg class="mic-icon" fill="currentColor" viewBox="0 0 20 20">
          <path
            fill-rule="evenodd"
            d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z"
            clip-rule="evenodd"
          />
        </svg>
      </button>
    {:else if isRecording && isRecordingForCurrentSession}
      <button
        class="record-button recording"
        onclick={onStopRecording}
        title="Stop recording and send"
      >
        <div class="recording-dot"></div>
        <svg class="mic-icon" fill="currentColor" viewBox="0 0 20 20">
          <path
            fill-rule="evenodd"
            d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z"
            clip-rule="evenodd"
          />
        </svg>
      </button>
    {:else if !isRecording}
      <button
        class="record-button"
        onclick={onStartRecording}
        title="Record voice prompt"
      >
        <svg class="mic-icon" fill="currentColor" viewBox="0 0 20 20">
          <path
            fill-rule="evenodd"
            d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z"
            clip-rule="evenodd"
          />
        </svg>
      </button>
    {/if}
    <div class="send-split">
      <button
        class="send-main"
        class:has-caret={showScheduleCaret}
        onclick={handleSendPrompt}
        disabled={(!prompt.trim() && pendingImages.length === 0) ||
          isRecording ||
          isTranscribing}
        title={isQuerying ? "Send and interrupt" : "Send"}
      >
        Send
      </button>
      {#if showScheduleCaret}
        <button
          class="send-caret"
          onclick={() => (scheduleMenuOpen = !scheduleMenuOpen)}
          disabled={!canScheduleSend}
          title="Send on next usage-window reset"
          aria-label="Send options"
          aria-haspopup="menu"
          aria-expanded={scheduleMenuOpen}
        >
          <svg viewBox="0 0 20 20" fill="currentColor" class="caret-icon">
            <path
              fill-rule="evenodd"
              d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
              clip-rule="evenodd"
            />
          </svg>
        </button>
      {/if}
      {#if scheduleMenuOpen}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="send-menu-backdrop" onclick={() => (scheduleMenuOpen = false)}></div>
        <div class="send-menu" role="menu">
          <button class="send-menu-item" role="menuitem" onclick={() => handleScheduleSend("5h")}>
            <span class="menu-item-label">Send on next 5h reset</span>
            {#if countdown5h}<span class="menu-item-countdown">in {countdown5h}</span>{/if}
          </button>
          <button class="send-menu-item" role="menuitem" onclick={() => handleScheduleSend("7d")}>
            <span class="menu-item-label">Send on next 7d reset</span>
            {#if countdown7d}<span class="menu-item-countdown">in {countdown7d}</span>{/if}
          </button>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .input-area {
    display: flex;
    align-items: flex-end;
    gap: 0.75rem;
    padding: 1rem;
    border-top: 1px solid var(--color-border);
    background: var(--color-background);
    position: relative;
  }

  .textarea-wrapper {
    flex: 1;
    position: relative;
  }

  textarea {
    display: block;
    width: 100%;
    background: var(--color-surface);
    color: var(--color-text-primary);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 0.75rem 2.5rem 0.75rem 0.75rem;
    resize: none;
    font-family: inherit;
    font-size: 0.9rem;
    line-height: 1.4;
    min-height: unset;
    max-height: 200px;
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

  .button-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  button {
    background: var(--color-accent);
    color: var(--color-background);
    border: none;
    border-radius: 6px;
    padding: 0.75rem 1.5rem;
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.2s;
    min-width: 80px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
  }

  button:hover:not(:disabled) {
    background: var(--color-accent-hover);
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Send split-button (Send + schedule caret) */
  .send-split {
    position: relative;
    display: flex;
    align-items: stretch;
  }

  .send-main.has-caret {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }

  .send-caret {
    min-width: unset;
    padding: 0 0.4rem;
    border-radius: 0 6px 6px 0;
    border-left: 1px solid color-mix(in srgb, var(--color-background) 30%, transparent);
  }

  .caret-icon {
    width: 16px;
    height: 16px;
  }

  .send-menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 20;
    background: transparent;
  }

  .send-menu {
    position: absolute;
    bottom: calc(100% + 6px);
    right: 0;
    z-index: 21;
    min-width: 220px;
    display: flex;
    flex-direction: column;
    padding: 0.25rem;
    background: var(--color-surface-elevated);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
  }

  .send-menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    width: 100%;
    min-width: unset;
    padding: 0.5rem 0.625rem;
    background: transparent;
    color: var(--color-text-primary);
    border-radius: 6px;
    font-size: 0.8125rem;
    font-weight: 500;
  }

  .send-menu-item:hover:not(:disabled) {
    background: var(--color-border);
  }

  .menu-item-label {
    white-space: nowrap;
  }

  .menu-item-countdown {
    font-size: 0.7rem;
    color: var(--color-text-muted);
    white-space: nowrap;
  }

  .stop-button {
    background: var(--color-error);
    padding: 0.75rem;
    min-width: unset;
  }

  .stop-button:hover {
    background: color-mix(in srgb, var(--color-error) 80%, black);
  }

  .stop-icon {
    width: 16px;
    height: 16px;
  }

  .record-button {
    background: var(--color-recording);
    color: white;
    border: none;
    border-radius: 6px;
    padding: 0.75rem;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    position: relative;
    min-width: unset;
  }

  .record-button:hover {
    background: color-mix(in srgb, var(--color-recording) 85%, black);
    color: white;
  }

  .record-button.recording {
    background: var(--color-recording);
    color: white;
  }

  .record-button.recording:hover {
    background: color-mix(in srgb, var(--color-recording) 80%, black);
  }

  .mic-icon {
    width: 18px;
    height: 18px;
  }

  .recording-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: white;
    flex-shrink: 0;
    animation: pulse-recording 1.5s ease-in-out infinite;
  }

  @keyframes pulse-recording {
    0%,
    100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.4;
      transform: scale(0.8);
    }
  }

  .record-button.transcribing {
    background: var(--color-warning, #f59e0b);
    color: var(--color-background);
    cursor: wait;
  }

  .record-button.transcribing:disabled {
    opacity: 1;
  }

  .transcribing-spinner {
    position: absolute;
    inset: 4px;
    border: 2px solid transparent;
    border-top-color: var(--color-background);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  /* Pending images preview */
  .pending-images {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.5rem;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-bottom: none;
    border-radius: 6px 6px 0 0;
  }

  .pending-image {
    position: relative;
    width: 80px;
    height: 80px;
    border-radius: 4px;
    overflow: hidden;
    background: var(--color-surface-elevated);
  }

  .pending-image img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .pending-image .remove-image {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 20px;
    height: 20px;
    min-width: unset;
    padding: 2px;
    background: rgba(0, 0, 0, 0.7);
    border: none;
    border-radius: 50%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity 0.2s;
  }

  .pending-image:hover .remove-image {
    opacity: 1;
  }

  .pending-image .remove-image svg {
    width: 12px;
    height: 12px;
    color: #fff;
  }

  .pending-image .remove-image:hover {
    background: color-mix(in srgb, var(--color-error) 90%, transparent);
  }

  .pending-image .image-size {
    position: absolute;
    bottom: 2px;
    left: 2px;
    font-size: 0.65rem;
    color: #fff;
    background: rgba(0, 0, 0, 0.7);
    padding: 1px 4px;
    border-radius: 2px;
  }

  .pending-image.processing {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .processing-spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--color-border);
    border-top-color: var(--color-accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Adjust textarea when images are present */
  .input-area:has(.pending-images) textarea {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
    border-top: none;
  }

  /* Inline record button - positioned inside textarea */
  .inline-record-btn {
    position: absolute;
    top: 50%;
    right: 6px;
    transform: translateY(-50%);
    width: 28px;
    height: 28px;
    min-width: unset;
    padding: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--color-text-muted);
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
    z-index: 1;
  }

  .inline-record-btn:hover:not(:disabled) {
    background: var(--color-surface-elevated);
    color: var(--color-text-primary);
  }

  .inline-record-btn.recording {
    background: var(--color-recording);
    color: white;
    animation: pulse-inline 1.5s ease-in-out infinite;
  }

  .inline-record-btn.recording:hover {
    background: color-mix(in srgb, var(--color-recording) 80%, black);
  }

  .inline-record-btn.transcribing {
    color: var(--color-warning, #f59e0b);
    cursor: wait;
  }

  .inline-record-btn.transcribing:disabled {
    opacity: 1;
  }

  .inline-mic-icon {
    width: 14px;
    height: 14px;
  }

  @keyframes pulse-inline {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.55;
    }
  }

  .inline-transcribing-spinner {
    position: absolute;
    inset: 4px;
    border: 2px solid transparent;
    border-top-color: var(--color-warning, #f59e0b);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  /* Drag and drop indicator */
  .input-area.drag-over::before {
    content: "Drop images here";
    position: absolute;
    inset: 0;
    background: color-mix(in srgb, var(--color-accent) 10%, transparent);
    border: 2px dashed var(--color-accent);
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-accent);
    font-weight: 500;
    z-index: 10;
  }
</style>
