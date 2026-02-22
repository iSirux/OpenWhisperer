import { writable } from 'svelte/store';

/**
 * Store to communicate recording state from the recording flow composable
 * to the AppHeader (which lives in the layout, decoupled from the page).
 */
export const isRecordingForNewSession = writable(false);

/**
 * Store to signal a pending recording action from the AppHeader.
 * When the user clicks Record/Stop from a non-main route (e.g. /settings),
 * we navigate back to '/' and set this store so that +page.svelte can
 * trigger the action once it has fully mounted and initialized.
 */
export const pendingHeaderAction = writable<'start' | 'stop' | null>(null);
