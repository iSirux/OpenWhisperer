// Shared "make this session the active one" logic, used by the sidebar list
// and the Ctrl+number session-switching hotkey so both behave identically.

import { activeSessionId } from '$lib/stores/sessions';
import { activeSdkSessionId, sdkSessions } from '$lib/stores/sdkSessions';
import { activeExecutionId } from '$lib/stores/sequenceExecutions';
import { navigation } from '$lib/stores/navigation';
import type { DisplaySession } from '$lib/types/session';

export function selectDisplaySession(session: DisplaySession): void {
  if (session.type === 'sequence') {
    activeExecutionId.set(session.id);
    activeSessionId.set(null);
    activeSdkSessionId.set(null);
    navigation.showSequences();
    return;
  }

  activeExecutionId.set(null);
  if (session.type === 'pty') {
    activeSessionId.set(session.id);
    activeSdkSessionId.set(null);
  } else {
    activeSdkSessionId.set(session.id);
    activeSessionId.set(null);
    sdkSessions.markAsRead(session.id);
  }
  window.dispatchEvent(new CustomEvent('switch-to-sessions'));
}
