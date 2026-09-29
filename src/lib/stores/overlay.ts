import { get, writable } from 'svelte/store';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { PhysicalPosition } from '@tauri-apps/api/dpi';
import { primaryMonitor } from '@tauri-apps/api/window';
import { emit } from '@tauri-apps/api/event';

export type OverlayMode = 'session' | 'paste' | 'inline' | 'meeting';

export interface OverlayActivityInfo {
  activeSessions: number;
  activeSequences: number;
}

/**
 * Meeting Mode indicator state. While a meeting is active the overlay keeps a
 * persistent "● Meeting 00:42:10" row visible (consent/trust requirement), and
 * the dictation flow's `hide()` falls back to meeting mode instead of hiding.
 */
export interface OverlayMeetingInfo {
  meetingId: string;
  title: string;
  status: 'recording' | 'paused' | 'finalizing';
  /** Accumulated recording seconds as of `baseAt` (epoch ms) */
  durationSecs: number;
  baseAt: number;
}

interface OverlayStore {
  visible: boolean;
  position: { x: number; y: number };
  mode: OverlayMode;
  sessionInfo: {
    branch: string | null;
    model: string | null;
    creatingSession: boolean;
  };
  inlineSessionInfo: {
    repoName: string | null;
    branch: string | null;
    model: string | null;
    promptPreview: string | null;
  } | null;
  activityInfo: OverlayActivityInfo;
  meetingInfo: OverlayMeetingInfo | null;
}

function getOverlayWindow() {
  return WebviewWindow.getByLabel('overlay');
}

function createOverlayStore() {
  const { subscribe, set, update } = writable<OverlayStore>({
    visible: false,
    position: { x: 0, y: 0 },
    mode: 'session',
    sessionInfo: {
      branch: null,
      model: null,
      creatingSession: false,
    },
    inlineSessionInfo: null,
    activityInfo: { activeSessions: 0, activeSequences: 0 },
    meetingInfo: null,
  });

  function currentMeetingInfo(): OverlayMeetingInfo | null {
    let info: OverlayMeetingInfo | null = null;
    const unsubscribe = subscribe((s) => (info = s.meetingInfo));
    unsubscribe();
    return info;
  }

  return {
    subscribe,

    async show() {
      try {
        const overlayWindow = await getOverlayWindow();
        if (overlayWindow) {
          await overlayWindow.show();
          // Don't steal focus - let user continue working in their current app
        }
        update((s) => ({ ...s, visible: true }));
      } catch (error) {
        console.error('Failed to show overlay:', error);
      }
    },

    async hide() {
      // A live meeting keeps its indicator visible: the dictation flow's stop
      // paths call hide(), which here restores meeting mode instead.
      if (currentMeetingInfo()) {
        this.setMode('meeting');
        return;
      }
      try {
        const overlayWindow = await getOverlayWindow();
        if (overlayWindow) {
          await overlayWindow.hide();
        }
        update((s) => ({ ...s, visible: false }));
      } catch (error) {
        console.error('Failed to hide overlay:', error);
      }
    },

    async toggle() {
      const current = await new Promise<boolean>((resolve) => {
        const unsubscribe = subscribe((s) => {
          resolve(s.visible);
          unsubscribe();
        });
      });

      if (current) {
        await this.hide();
      } else {
        await this.show();
      }
    },

    async setPosition(x: number, y: number) {
      try {
        const overlayWindow = await getOverlayWindow();
        if (overlayWindow) {
          await overlayWindow.setPosition(new PhysicalPosition(x, y));
        }
        update((s) => ({ ...s, position: { x, y } }));
      } catch (error) {
        console.error('Failed to set overlay position:', error);
      }
    },

    async centerTop() {
      try {
        const monitor = await primaryMonitor();
        if (monitor) {
          const x = Math.round((monitor.size.width - 380) / 2);
          const y = 20;
          await this.setPosition(x, y);
        }
      } catch (error) {
        console.error('Failed to center overlay:', error);
      }
    },

    setSessionInfo(branch: string | null, model: string | null, creatingSession: boolean) {
      update((s) => ({
        ...s,
        sessionInfo: { branch, model, creatingSession },
      }));
      // Emit event to sync with overlay window
      emit('overlay-session-info', { branch, model, creatingSession });
    },

    // Update session info without emitting (used when receiving event from another window)
    updateSessionInfoLocal(branch: string | null, model: string | null, creatingSession: boolean) {
      update((s) => ({
        ...s,
        sessionInfo: { branch, model, creatingSession },
      }));
    },

    clearSessionInfo() {
      update((s) => ({
        ...s,
        sessionInfo: { branch: null, model: null, creatingSession: false },
      }));
      // Emit event to sync with overlay window
      emit('overlay-session-info', { branch: null, model: null, creatingSession: false });
    },

    setMode(mode: OverlayMode) {
      update((s) => ({ ...s, mode }));
      // Emit event to sync with overlay window
      emit('overlay-mode', { mode });
    },

    // Update mode without emitting (used when receiving event from another window)
    updateModeLocal(mode: OverlayMode) {
      update((s) => ({ ...s, mode }));
    },

    setInlineSessionInfo(info: {
      repoName: string | null;
      branch: string | null;
      model: string | null;
      promptPreview: string | null;
    }) {
      update((s) => ({ ...s, inlineSessionInfo: info }));
      // Emit event to sync with overlay window
      emit('overlay-inline-session-info', info);
    },

    // Update inline session info without emitting (used when receiving event from another window)
    updateInlineSessionInfoLocal(info: {
      repoName: string | null;
      branch: string | null;
      model: string | null;
      promptPreview: string | null;
    } | null) {
      update((s) => ({ ...s, inlineSessionInfo: info }));
    },

    clearInlineSessionInfo() {
      update((s) => ({ ...s, inlineSessionInfo: null }));
      // Emit event to sync with overlay window
      emit('overlay-inline-session-info', null);
    },

    setActivityInfo(activeSessions: number, activeSequences: number) {
      // Called on every sessions-store write (streaming events); the counts rarely move, and
      // each call would otherwise be a store fan-out plus a cross-window IPC emit.
      const current = get({ subscribe }).activityInfo;
      if (current.activeSessions === activeSessions && current.activeSequences === activeSequences) return;
      update((s) => ({ ...s, activityInfo: { activeSessions, activeSequences } }));
      // Emit event to sync with overlay window
      emit('overlay-activity-info', { activeSessions, activeSequences });
    },

    // Update activity info without emitting (used when receiving event from another window)
    updateActivityInfoLocal(activeSessions: number, activeSequences: number) {
      update((s) => ({ ...s, activityInfo: { activeSessions, activeSequences } }));
    },

    /**
     * Set (or clear with null) the meeting indicator. Starting a meeting shows
     * the overlay in meeting mode; ending it hides the overlay unless a
     * dictation recording is using it.
     */
    async setMeetingInfo(info: OverlayMeetingInfo | null, opts: { dictationActive?: boolean } = {}) {
      const had = currentMeetingInfo() !== null;
      update((s) => ({ ...s, meetingInfo: info }));
      emit('overlay-meeting-info', info);
      if (info && !had) {
        if (!opts.dictationActive) this.setMode('meeting');
        await this.show();
      } else if (!info && had && !opts.dictationActive) {
        this.setMode('session');
        await this.hide();
      }
    },

    // Update meeting info without emitting (used when receiving event from another window)
    updateMeetingInfoLocal(info: OverlayMeetingInfo | null) {
      update((s) => ({ ...s, meetingInfo: info }));
    },
  };
}

export const overlay = createOverlayStore();
