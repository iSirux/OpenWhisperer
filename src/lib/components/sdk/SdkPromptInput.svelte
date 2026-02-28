<script lang="ts">
  import { onDestroy } from "svelte";
  import type { SdkImageContent } from "$lib/stores/sdkSessions";
  import {
    getImagesFromClipboard,
    getImagesFromDrop,
    processImages,
    createPreviewUrl,
    formatFileSize,
    type ImageData,
  } from "$lib/utils/image";

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
    onSendPrompt,
    onStopQuery,
    onStartRecording,
    onStopRecording,
    onStartInlineRecording,
    onStopInlineRecording,
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
    onSendPrompt: (prompt: string, images?: SdkImageContent[]) => void;
    onStopQuery: () => void;
    onStartRecording: () => void;
    onStopRecording: () => void;
    onStartInlineRecording: () => void;
    onStopInlineRecording: () => void;
    onDraftChange?: (prompt: string, images: SdkImageContent[]) => void;
  } = $props();

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

  function flushDraftChange() {
    if (!onDraftChange) return;
    if (draftChangeTimeout) {
      clearTimeout(draftChangeTimeout);
      draftChangeTimeout = null;
    }
    onDraftChange(prompt, getImageContent());
  }

  function notifyDraftChange() {
    if (!onDraftChange) return;
    if (draftChangeTimeout) clearTimeout(draftChangeTimeout);
    draftChangeTimeout = setTimeout(() => {
      draftChangeTimeout = null;
      onDraftChange(prompt, getImageContent());
    }, 300);
  }

  // Reset local state ONLY when session ID changes (actual session switch)
  // This prevents resetting when tool calls update the session store
  $effect(() => {
    const draftImagesKey = JSON.stringify(draftImages);

    if (sessionId !== prevSessionId) {
      // Clear any pending debounced save (the parent handles saving before switch)
      if (draftChangeTimeout) {
        clearTimeout(draftChangeTimeout);
        draftChangeTimeout = null;
      }

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
    onDraftChange?.("", []);
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
    flushDraftChange();
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

    prompt = "";
    pendingImages = [];
    // Clear draft in parent store
    onDraftChange?.("", []);
    onSendPrompt(currentPrompt, imageContent);
  }

  async function handlePaste(e: ClipboardEvent) {
    const imageFiles = await getImagesFromClipboard(e);
    if (imageFiles.length > 0) {
      e.preventDefault();
      await addImages(imageFiles);
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
      placeholder={pendingImages.length > 0
        ? "Add a message about the image(s)... (Enter to send)"
        : "Enter your prompt... (Ctrl+V to paste images, Enter to send)"}
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
    <button
      onclick={handleSendPrompt}
      disabled={!prompt.trim() && pendingImages.length === 0}
      title={isQuerying ? "Send and interrupt" : "Send"}
    >
      Send
    </button>
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
