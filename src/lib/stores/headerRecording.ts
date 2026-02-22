import { writable } from 'svelte/store';

/**
 * Store to communicate recording state from the recording flow composable
 * to the AppHeader (which lives in the layout, decoupled from the page).
 */
export const isRecordingForNewSession = writable(false);
