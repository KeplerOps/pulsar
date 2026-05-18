// Pulsar L2 — design token TS exports.
//
// Mirrors the CSS custom properties in `./tokens.css` so templates that
// need typed access to a token value (e.g. GSAP tween durations driven
// from `--pulsar-motion-slow`) can read it via a TS constant rather
// than `getComputedStyle()`. Keeping the two surfaces aligned is a
// test invariant — see `tests/system/register-tokens.test.ts`.
//
// Naming mirrors the CSS custom property without the `--pulsar-` prefix
// and converted to camelCase: `--pulsar-motion-slow` → `motion.slow`.

export const color = {
  bgDeep: '#0a0a0d',
  bgMid: '#15161b',
  bgInk: '#08090c',

  fgWhite: '#ffffff',
  fgSoft: 'rgba(255, 255, 255, 0.95)',
  fgDim: 'rgba(255, 255, 255, 0.85)',
  fgFaint: 'rgba(255, 255, 255, 0.42)',
  fgHair: 'rgba(255, 255, 255, 0.32)',

  accentCyan: '#7df5ff',
  accentRed: '#ff3b3b',
  accentRedMid: '#ff5862',
  accentRedLow: '#cc1020',

  brandOrange: '#fa582d',
  brandGreen: '#00cc66',
  brandBlue: '#2f8cff',
} as const;

export const motion = {
  // Durations in milliseconds (GSAP wants seconds — divide by 1000 at
  // the call site, or use `gsapDuration(motion.base)`).
  instantMs: 80,
  fastMs: 180,
  baseMs: 280,
  slowMs: 600,
  growMs: 6500,
} as const;

/** Convert a token millisecond value to GSAP's expected second unit. */
export const gsapDuration = (ms: number): number => ms / 1000;

export const z = {
  stage: 0,
  scene: 10,
  chromeSlot: 40,
  vignette: 47,
  scanlines: 48,
  grain: 49,
  bars: 50,
  flash: 51,
  transition: 60,
  hud: 70,
} as const;

export const space = {
  letterboxVh: 5.5,
  railVw: 5,
  xsPx: 4,
  smPx: 8,
  mdPx: 16,
  lgPx: 28,
  xlPx: 48,
  xxlPx: 80,
} as const;

/**
 * Public list of CSS custom property names this register declares.
 * Used by the token-parity test to assert tokens.css and tokens.ts
 * stay aligned — adding a property to one side without the other
 * fails the test.
 */
export const CSS_TOKEN_NAMES: readonly string[] = [
  '--pulsar-color-bg-deep',
  '--pulsar-color-bg-mid',
  '--pulsar-color-bg-ink',
  '--pulsar-color-fg-white',
  '--pulsar-color-fg-soft',
  '--pulsar-color-fg-dim',
  '--pulsar-color-fg-faint',
  '--pulsar-color-fg-hair',
  '--pulsar-color-accent-cyan',
  '--pulsar-color-accent-red',
  '--pulsar-color-accent-red-mid',
  '--pulsar-color-accent-red-low',
  '--pulsar-color-brand-orange',
  '--pulsar-color-brand-green',
  '--pulsar-color-brand-blue',
  '--pulsar-type-display',
  '--pulsar-type-serif',
  '--pulsar-type-mono',
  '--pulsar-type-sans',
  '--pulsar-type-display-size',
  '--pulsar-type-h1-size',
  '--pulsar-type-h2-size',
  '--pulsar-type-h3-size',
  '--pulsar-type-body-size',
  '--pulsar-type-caption-size',
  '--pulsar-type-mono-size',
  '--pulsar-type-attribution-size',
  '--pulsar-type-display-tracking',
  '--pulsar-type-display-line',
  '--pulsar-type-body-line',
  '--pulsar-type-mono-line',
  '--pulsar-space-letterbox',
  '--pulsar-space-rail',
  '--pulsar-space-xs',
  '--pulsar-space-sm',
  '--pulsar-space-md',
  '--pulsar-space-lg',
  '--pulsar-space-xl',
  '--pulsar-space-2xl',
  '--pulsar-space-stack',
  '--pulsar-space-section',
  '--pulsar-motion-instant',
  '--pulsar-motion-fast',
  '--pulsar-motion-base',
  '--pulsar-motion-slow',
  '--pulsar-motion-grow',
  '--pulsar-motion-ease-entry',
  '--pulsar-motion-ease-exit',
  '--pulsar-motion-ease-slam',
  '--pulsar-motion-ease-shake',
  '--pulsar-z-stage',
  '--pulsar-z-scene',
  '--pulsar-z-chrome-slot',
  '--pulsar-z-vignette',
  '--pulsar-z-scanlines',
  '--pulsar-z-grain',
  '--pulsar-z-bars',
  '--pulsar-z-flash',
  '--pulsar-z-transition',
  '--pulsar-z-hud',
  '--pulsar-opacity-vignette',
  '--pulsar-opacity-scanlines',
  '--pulsar-opacity-grain',
  '--pulsar-opacity-tag',
];
