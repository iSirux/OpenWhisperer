import type { RepoConfig } from '$lib/stores/settings';

/**
 * Curated icon map for repository icons.
 * Each entry maps an icon name to its SVG path data for a 24x24 viewBox.
 * All icons use stroke style (Heroicons pattern) unless `fill` is true.
 */
export const REPO_ICON_MAP: Record<string, { paths: string; fill?: boolean }> = {
  // Web / Frontend
  globe: {
    paths: 'M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9',
  },
  browser: {
    paths: 'M3 5a2 2 0 012-2h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5zm0 4h18',
  },
  layout: {
    paths: 'M4 3h16a1 1 0 011 1v16a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1zm5 18V9m-6 0h18',
  },
  'paint-brush': {
    paths: 'M3 21v-4a4 4 0 014-4h0a4 4 0 014 4v0a2 2 0 002 2h0a2 2 0 002-2V5a2 2 0 012-2h2a2 2 0 012 2v6a3 3 0 01-3 3h-2',
  },
  palette: {
    paths: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-1 0-.83.67-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-4.96-4.49-9-10-9M6.5 13a1.5 1.5 0 110-3 1.5 1.5 0 010 3m3-5a1.5 1.5 0 110-3 1.5 1.5 0 010 3m5 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3m3 5a1.5 1.5 0 110-3 1.5 1.5 0 010 3',
  },

  // Backend / Server
  server: {
    paths: 'M5 12H3l9-9 9 9h-2M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7',
  },
  cloud: {
    paths: 'M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z',
  },
  api: {
    paths: 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4',
  },
  router: {
    paths: 'M12 2v6m0 8v6M4.93 4.93l4.24 4.24m5.66 5.66l4.24 4.24M2 12h6m8 0h6M4.93 19.07l4.24-4.24m5.66-5.66l4.24-4.24',
  },
  shield: {
    paths: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  },

  // Mobile
  smartphone: {
    paths: 'M7 2h10a1 1 0 011 1v18a1 1 0 01-1 1H7a1 1 0 01-1-1V3a1 1 0 011-1zm5 18h.01',
  },
  tablet: {
    paths: 'M6 2h12a1 1 0 011 1v18a1 1 0 01-1 1H6a1 1 0 01-1-1V3a1 1 0 011-1zm6 18h.01',
  },

  // CLI / Terminal
  terminal: {
    paths: 'M4 17l6-5-6-5m8 10h8',
  },
  'command-line': {
    paths: 'M2 5a2 2 0 012-2h16a2 2 0 012 2v14a2 2 0 01-2 2H4a2 2 0 01-2-2V5zm4 12l4-4-4-4m6 8h4',
  },

  // Database
  database: {
    paths: 'M12 2C6.48 2 2 3.79 2 6v12c0 2.21 4.48 4 10 4s10-1.79 10-4V6c0-2.21-4.48-4-10-4zM2 6c0 2.21 4.48 4 10 4s10-1.79 10-4M2 12c0 2.21 4.48 4 10 4s10-1.79 10-4',
  },
  table: {
    paths: 'M3 3h18v18H3V3zm0 6h18M3 15h18M9 3v18M15 3v18',
  },
  storage: {
    paths: 'M4 7v10c0 2.21 3.58 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.58 4 8 4s8-1.79 8-4M4 7c0-2.21 3.58-4 8-4s8 1.79 8 4',
  },

  // AI / ML
  brain: {
    paths: 'M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 01-2 2h-4a2 2 0 01-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 017-7zm0 17v3m-3-3h6',
  },
  sparkles: {
    paths: 'M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z',
  },
  cpu: {
    paths: 'M6 6h12v12H6V6zm3-4v4m6-4v4M5 10H1m4 4H1m18-4h4m-4 4h4M9 22v-4m6 4v-4',
  },

  // Libraries / Packages
  package: {
    paths: 'M16.5 9.4l-9-5.19M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z',
  },
  puzzle: {
    paths: 'M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 01-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 10-3.214 3.214c.446.166.855.497.925.968a.979.979 0 01-.276.837l-1.61 1.61a2.404 2.404 0 01-1.705.707 2.402 2.402 0 01-1.704-.706l-1.568-1.568a1.026 1.026 0 00-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 11-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 00-.289-.877l-1.568-1.568A2.402 2.402 0 011.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 103.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0112 2c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.878.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 113.237 3.237c-.464.18-.894.527-.967 1.02z',
  },
  cube: {
    paths: 'M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16zM3.27 6.96L12 12.01l8.73-5.05M12 22.08V12',
  },

  // Documentation
  book: {
    paths: 'M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5V4.5A2.5 2.5 0 016.5 2H20v20H6.5A2.5 2.5 0 014 19.5z',
  },
  document: {
    paths: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM14 2v6h6M16 13H8M16 17H8M10 9H8',
  },
  pencil: {
    paths: 'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z',
  },

  // Testing
  flask: {
    paths: 'M9 3h6m-5 0v6.5L4 18a1 1 0 001 1h14a1 1 0 001-1l-6-8.5V3m-4 0h6',
  },
  'check-circle': {
    paths: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
  },
  bug: {
    paths: 'M8 2l1.88 1.88M14.12 3.88L16 2M9 7.13v-1a3 3 0 116 0v1M12 20c-3.31 0-6-2.69-6-6v-2c0-3.31 2.69-6 6-6s6 2.69 6 6v2c0 3.31-2.69 6-6 6zM6 14H2m20 0h-4M6 10H2m20 0h-4m-6 10v-6',
  },

  // Desktop
  monitor: {
    paths: 'M3 4h18a1 1 0 011 1v11a1 1 0 01-1 1H3a1 1 0 01-1-1V5a1 1 0 011-1zm5 17h8m-4-4v4',
  },
  window: {
    paths: 'M3 3h18v18H3V3zm0 4h18M7 3v4',
  },
  desktop: {
    paths: 'M2 4a2 2 0 012-2h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V4zm6 18h8m-4-4v4',
  },

  // Games
  gamepad: {
    paths: 'M6 12h4m-2-2v4m7-1h.01M16 9h.01M2 15.27V8.73c0-1.04.84-1.88 1.88-1.88h16.24c1.04 0 1.88.84 1.88 1.88v6.54c0 1.04-.84 1.88-1.88 1.88H3.88C2.84 17.15 2 16.31 2 15.27z',
  },
  play: {
    paths: 'M5 3l14 9-14 9V3z',
  },

  // Data / Analytics
  'chart-bar': {
    paths: 'M12 20V10M18 20V4M6 20v-4',
  },
  'chart-line': {
    paths: 'M3 12l5-5 4 4 9-9M21 3h-6m6 0v6',
  },
  'pie-chart': {
    paths: 'M21.21 15.89A10 10 0 118 2.83M22 12A10 10 0 0012 2v10h10z',
  },

  // Communication
  chat: {
    paths: 'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z',
  },
  mail: {
    paths: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  },
  notification: {
    paths: 'M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0',
  },

  // Media
  camera: {
    paths: 'M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2v11zM12 17a4 4 0 100-8 4 4 0 000 8z',
  },
  video: {
    paths: 'M23 7l-7 5 7 5V7zM14 5H3a2 2 0 00-2 2v10a2 2 0 002 2h11a2 2 0 002-2V7a2 2 0 00-2-2z',
  },
  music: {
    paths: 'M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z',
  },
  microphone: {
    paths: 'M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2m7 9v4m-4 0h8',
  },

  // E-Commerce
  'shopping-cart': {
    paths: 'M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6M10 21a1 1 0 11-2 0 1 1 0 012 0zm10 0a1 1 0 11-2 0 1 1 0 012 0z',
  },
  'credit-card': {
    paths: 'M3 5h18a2 2 0 012 2v10a2 2 0 01-2 2H3a2 2 0 01-2-2V7a2 2 0 012-2zm-2 5h22',
  },
  tag: {
    paths: 'M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82zM7 7h.01',
  },

  // Security
  lock: {
    paths: 'M5 11h14a1 1 0 011 1v8a1 1 0 01-1 1H5a1 1 0 01-1-1v-8a1 1 0 011-1zm2 0V7a5 5 0 0110 0v4',
  },
  key: {
    paths: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
  },
  fingerprint: {
    paths: 'M12 10v4m-4-2a4 4 0 018 0m-12 0a8 8 0 0116 0m-8-8v1m-6.36 2.64l.7.7m12.02-.7l-.7.7M4 12H3m18 0h-1',
  },

  // Files / Storage
  folder: {
    paths: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z',
  },
  file: {
    paths: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm-1 1v5h5',
  },
  archive: {
    paths: 'M21 8v13H3V8M1 3h22v5H1V3zm9 9h4',
  },
  'cloud-upload': {
    paths: 'M16 16l-4-4-4 4m4-4v9M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3',
  },

  // Version Control
  'git-branch': {
    paths: 'M6 3v12m0 0a3 3 0 103 3M6 15a3 3 0 10-3 3m15-9a3 3 0 100-6 3 3 0 000 6zm0 0c0 3-2 5-6 6',
  },
  merge: {
    paths: 'M18 21a3 3 0 100-6 3 3 0 000 6zM6 9a3 3 0 100-6 3 3 0 000 6zm0 0v12m0-12c3 0 9 3 12 6',
  },
  fork: {
    paths: 'M6 3v6m0 0a3 3 0 103 3V9H6zm0 0H3a3 3 0 003 3m12-9v6m0 0a3 3 0 103 3v-3h-3zm0 0h-3a3 3 0 003 3M12 15v6',
  },

  // Misc
  rocket: {
    paths: 'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09zM12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z',
  },
  lightning: {
    paths: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  },
  wrench: {
    paths: 'M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z',
  },
  cog: {
    paths: 'M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z',
  },
  heart: {
    paths: 'M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z',
  },
  star: {
    paths: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
  },
  zap: {
    paths: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  },
  code: {
    paths: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  },
  brackets: {
    paths: 'M7 3H4a1 1 0 00-1 1v7l2 2-2 2v7a1 1 0 001 1h3m10-20h3a1 1 0 011 1v7l-2 2 2 2v7a1 1 0 01-1 1h-3',
  },
  hash: {
    paths: 'M4 9h16M4 15h16M10 3l-2 18M16 3l-2 18',
  },
  robot: {
    paths: 'M12 2a2 2 0 012 2v1h3a2 2 0 012 2v9a4 4 0 01-4 4H9a4 4 0 01-4-4V7a2 2 0 012-2h3V4a2 2 0 012-2zm-3 10h.01M15 12h.01M1 12h2m18 0h2',
  },
  users: {
    paths: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zm14 10v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',
  },
  earth: {
    paths: 'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zM2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z',
  },
};

/** List of all available icon names for LLM prompting and UI dropdowns */
export const REPO_ICON_NAMES: string[] = Object.keys(REPO_ICON_MAP);

/**
 * Curated color palette for repo backgrounds.
 * Colors are vibrant enough to provide visual distinction across themes.
 */
export const REPO_COLORS: string[] = [
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#a855f7', // purple
  '#ec4899', // pink
  '#ef4444', // red
  '#f97316', // orange
  '#f59e0b', // amber
  '#eab308', // yellow
  '#84cc16', // lime
  '#22c55e', // green
  '#10b981', // emerald
  '#14b8a6', // teal
  '#06b6d4', // cyan
  '#0ea5e9', // sky
  '#3b82f6', // blue
  '#6d28d9', // dark violet
  '#db2777', // dark pink
  '#0891b2', // dark cyan
  '#059669', // dark emerald
  '#7c3aed', // medium purple
];

/**
 * Get SVG path data for an icon key.
 * Falls back to the "code" icon if the key is unknown or undefined.
 */
export function getRepoIconPaths(iconKey: string | undefined): string {
  if (!iconKey) return REPO_ICON_MAP['code'].paths;
  return REPO_ICON_MAP[iconKey]?.paths ?? REPO_ICON_MAP['code'].paths;
}

/**
 * Parse a hex color string to RGB components.
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const cleaned = hex.replace('#', '');
  return {
    r: parseInt(cleaned.substring(0, 2), 16),
    g: parseInt(cleaned.substring(2, 4), 16),
    b: parseInt(cleaned.substring(4, 6), 16),
  };
}

/**
 * Calculate relative luminance per WCAG 2.0.
 */
function getRelativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * Determine the best contrast color (white or black) for text/icons
 * displayed on a given background color.
 * Uses WCAG 2.0 relative luminance threshold.
 */
export function getContrastColor(hexColor: string): '#ffffff' | '#000000' {
  try {
    const { r, g, b } = hexToRgb(hexColor);
    const luminance = getRelativeLuminance(r, g, b);
    return luminance > 0.179 ? '#000000' : '#ffffff';
  } catch {
    return '#ffffff';
  }
}

/**
 * Get a deterministic color for a repo based on its path.
 * Same path always returns the same color from the palette.
 */
export function getDefaultRepoColor(repoPath: string): string {
  let hash = 0;
  const str = repoPath || 'default';
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return REPO_COLORS[Math.abs(hash) % REPO_COLORS.length];
}

/**
 * Look up a RepoConfig by its path from the repos array.
 * Returns null if not found.
 */
export function findRepoByPath(
  repos: RepoConfig[],
  path: string | undefined
): RepoConfig | null {
  if (!path) return null;
  return repos.find((r) => r.path === path) ?? null;
}

/**
 * Get the effective color for a repo (stored color or deterministic fallback).
 */
export function getRepoColor(repo: RepoConfig | null): string {
  if (repo?.color) return repo.color;
  return getDefaultRepoColor(repo?.path || '');
}

/**
 * Get the effective icon key for a repo (stored icon or default).
 */
export function getRepoIconKey(repo: RepoConfig | null): string {
  return repo?.icon || 'code';
}
