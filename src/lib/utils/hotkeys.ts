function normalizeHotkeyKey(key: string): string {
  const keyMap: Record<string, string> = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Escape: 'Escape',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Tab: 'Tab',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert',
  };

  if (keyMap[key]) return keyMap[key];
  if (key.length === 1) return key.toUpperCase();
  if (key.startsWith('F') && key.length <= 3) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function formatHotkeyForDisplay(hotkey: string): string {
  if (!hotkey) return '';
  return hotkey.replace(/CommandOrControl/g, 'Ctrl').replace(/\+/g, ' + ');
}

export function eventMatchesHotkey(event: KeyboardEvent, hotkey: string): boolean {
  if (!hotkey) return false;

  const parts = hotkey.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return false;

  const requiresCmdOrCtrl = parts.includes('CommandOrControl');
  const requiresAlt = parts.includes('Alt');
  const requiresShift = parts.includes('Shift');
  const hotkeyKey = parts.find((part) => !['CommandOrControl', 'Alt', 'Shift'].includes(part));
  if (!hotkeyKey) return false;

  const hasCmdOrCtrl = event.ctrlKey || event.metaKey;
  if (requiresCmdOrCtrl !== hasCmdOrCtrl) return false;
  if (requiresAlt !== event.altKey) return false;
  if (requiresShift !== event.shiftKey) return false;

  return normalizeHotkeyKey(event.key) === normalizeHotkeyKey(hotkeyKey);
}

export function isEditableElement(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return true;
  }
  return element.isContentEditable || Boolean(element.closest('[contenteditable="true"]'));
}
