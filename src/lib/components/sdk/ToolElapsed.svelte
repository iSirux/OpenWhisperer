<script lang="ts">
  import { clock } from "$lib/stores/clock";
  import { formatDuration } from "$lib/utils/duration";

  // Live elapsed time of a running tool call. Its own component so only running
  // cards subscribe to the clock.
  let { since }: { since: number } = $props();
</script>

{formatDuration(Math.max(0, Math.floor(($clock - since) / 1000)))}
