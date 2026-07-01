export const isMac =
  typeof navigator !== "undefined" &&
  (/Mac/i.test(navigator.platform) || /Mac/i.test(navigator.userAgent));

// Primary modifier: ⌘ on Mac, Ctrl+ on Windows/Linux
export function modKey(key: string, winKey = key): string {
  return isMac ? `⌘${key}` : `Ctrl+${winKey}`;
}

// Secondary ctrl modifier: ⌃ on Mac, Ctrl+ on Windows/Linux
export function ctrlKey(key: string, winKey = key): string {
  return isMac ? `⌃${key}` : `Ctrl+${winKey}`;
}
