/**
 * Papyrus design tokens — Beag Labs neobrutalist system.
 *
 * Inspired by OiiOii's clean dark UI but adapted for secure product development.
 * Orange accent retained as the Papyrus brand signal.
 */
export const tokens = {
  color: {
    bg: '#f7f7f5',
    surface: '#ffffff',
    surfaceHover: '#fff1e9',
    surfaceActive: '#ffe1d2',
    border: '#111111',
    borderLight: '#292929',
    text: '#0a0a0a',
    textMuted: '#3f3f3f',
    textDim: '#6b6b6b',
    accent: '#ff5f1f',
    accentHover: '#ff7a1a',
    accentMuted: 'rgba(255, 95, 31, 0.15)',
    success: '#22c55e',
    error: '#ef4444',
    white: '#ffffff',
    black: '#000000',
    /** Persona colors — each agent persona gets a signature hue. */
    persona: {
      pm: '#ff5f1f',
      designer: '#a78bfa',
      engineer: '#60a5fa',
      security: '#facc15',
      validator: '#34d399',
    } as Record<string, string>,
    /** Category colors for canvas cards. */
    category: {
      discovery: '#60a5fa',
      strategy: '#ff5f1f',
      design: '#a78bfa',
      engineering: '#60a5fa',
      'ai-skill': '#ff7a1a',
      validation: '#34d399',
      transition: '#facc15',
      output: '#34d399',
    } as Record<string, string>,
  },
  border: {
    width: 1,
    widthLg: 2,
    style: 'solid',
    color: '#111111',
  },
  shadow: {
    sm: '4px 4px 0 #111111',
    md: '6px 6px 0 #111111',
    lg: '8px 8px 0 #111111',
    glow: '6px 6px 0 #ff5f1f',
  },
  radius: {
    sm: '8px',
    md: '14px',
    lg: '22px',
    full: '9999px',
  },
  spacing: {
    xs: '4px',
    sm: '8px',
    md: '12px',
    lg: '16px',
    xl: '24px',
    '2xl': '32px',
    '3xl': '48px',
  },
  font: {
    display: '"Inter", system-ui, -apple-system, sans-serif',
    body: '"Inter", system-ui, -apple-system, sans-serif',
    mono: '"JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace',
  },
  weight: {
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
    extrabold: 800,
  },
} as const

/** Light theme overrides. */
export const lightTheme = {
  color: {
    bg: '#f8f8f8',
    surface: '#ffffff',
    surfaceHover: '#f0f0f0',
    surfaceActive: '#e8e8e8',
    border: '#e0e0e0',
    borderLight: '#d0d0d0',
    text: '#1a1a1a',
    textMuted: '#666666',
    textDim: '#999999',
    accent: '#ff5f1f',
    accentHover: '#ff7a1a',
    accentMuted: 'rgba(255, 95, 31, 0.1)',
    success: '#16a34a',
    error: '#dc2626',
    white: '#ffffff',
    black: '#000000',
    persona: {
      pm: '#ff5f1f',
      designer: '#a78bfa',
      engineer: '#60a5fa',
      security: '#facc15',
      validator: '#34d399',
    } as Record<string, string>,
    category: {
      discovery: '#3b82f6',
      strategy: '#ff5f1f',
      design: '#a78bfa',
      engineering: '#3b82f6',
      'ai-skill': '#ff7a1a',
      validation: '#34d399',
      transition: '#facc15',
      output: '#34d399',
    } as Record<string, string>,
  },
  border: {
    width: 1,
    widthLg: 2,
    style: 'solid',
    color: '#e0e0e0',
  },
  shadow: {
    sm: '0 1px 3px rgba(0,0,0,0.08)',
    md: '0 4px 12px rgba(0,0,0,0.1)',
    lg: '0 8px 24px rgba(0,0,0,0.12)',
    glow: '0 0 20px rgba(255, 95, 31, 0.1)',
  },
  radius: {
    sm: '6px',
    md: '10px',
    lg: '16px',
    full: '9999px',
  },
  spacing: {
    xs: '4px',
    sm: '8px',
    md: '12px',
    lg: '16px',
    xl: '24px',
    '2xl': '32px',
    '3xl': '48px',
  },
  font: tokens.font,
  weight: tokens.weight,
} as const

export type DesignTokens = typeof tokens
