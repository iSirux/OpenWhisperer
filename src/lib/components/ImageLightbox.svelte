<script lang="ts">
  import { viewedImage, closeImage } from '$lib/stores/imageViewer';

  // Fit-to-window by default; clicking the image toggles actual size (scrollable).
  let actualSize = $state(false);

  $effect(() => {
    if (!$viewedImage) actualSize = false;
  });

  function handleKeydown(e: KeyboardEvent): void {
    if ($viewedImage && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeImage();
    }
  }
</script>

<svelte:window onkeydowncapture={handleKeydown} />

{#if $viewedImage}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="lightbox" class:actual-size={actualSize} onclick={closeImage}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <img
      src={$viewedImage.src}
      alt={$viewedImage.alt ?? ''}
      title={actualSize ? 'Click to fit to window' : 'Click for actual size'}
      onclick={(e) => {
        e.stopPropagation();
        actualSize = !actualSize;
      }}
    />
    <button class="close-btn" onclick={closeImage} title="Close (Esc)" aria-label="Close">
      <svg viewBox="0 0 20 20" fill="currentColor">
        <path
          fill-rule="evenodd"
          d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
          clip-rule="evenodd"
        />
      </svg>
    </button>
  </div>
{/if}

<style>
  .lightbox {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    background: rgba(0, 0, 0, 0.8);
    cursor: zoom-out;
    overflow: auto;
  }

  .lightbox img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: 4px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
    cursor: zoom-in;
  }

  /* Actual size: let the image overflow and scroll from its top-left corner. */
  .lightbox.actual-size {
    align-items: flex-start;
    justify-content: flex-start;
  }

  .lightbox.actual-size img {
    max-width: none;
    max-height: none;
    margin: auto;
    cursor: zoom-out;
  }

  .close-btn {
    position: fixed;
    top: 1rem;
    right: 1rem;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    border: none;
    border-radius: 9999px;
    background: rgba(0, 0, 0, 0.6);
    color: rgba(255, 255, 255, 0.85);
    cursor: pointer;
  }

  .close-btn:hover {
    background: rgba(0, 0, 0, 0.85);
    color: white;
  }

  .close-btn svg {
    width: 1.1rem;
    height: 1.1rem;
  }
</style>
