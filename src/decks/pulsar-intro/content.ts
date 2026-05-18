// Pulsar reference deck — self-referential introduction.
//
// Twelve scenes that collectively exercise every L2 template, every
// chrome treatment, and every transition shape. Reachable in the
// workbench at `?composition=pulsar-intro`.
//
// This file is the proof: a deck is composition manifest + content.
// Authoring a new scene is one factory call with a content object.

import type { SceneModule } from '../../runtime/scene';
import {
  actHeader,
  bulletList,
  centerpiece,
  compare,
  definitionTable,
  introGrid,
  metricTicker,
  outlineTitle,
  outro,
  placard,
  quote,
  quoteStack,
  statBig,
  statPairGrid,
  statRow,
  titleSlam,
} from '../../system/templates';

export const PULSAR_INTRO_SCENES: readonly SceneModule[] = [
  titleSlam('pi-title', {
    title: 'Pulsar',
    subtitle: 'A scene-and-composition runtime for cinematic browser presentations.',
  }),

  placard('pi-opener', {
    line1: 'The runtime is the product.',
    line2: 'Reference deck — built on the L2 system layer',
  }),

  actHeader('pi-act-i', { act: 'I', section: 'Why' }),

  statBig('pi-stat-bespoke', {
    value: '12k',
    label: 'lines of bespoke code per deck, today',
  }),

  bulletList('pi-bullets-pain', {
    eyebrow: 'the problem',
    title: 'Every deck is a fresh refactor.',
    bullets: [
      'Hand-rolled vignette, scanlines, grain, glitch — once per deck.',
      'Hand-rolled keyboard advance, abortable sleep, type-on text.',
      'Hand-rolled scene templates — title, stat row, quote, intro grid.',
      'No reuse across talks. No design system. No system layer at all.',
    ],
  }),

  actHeader('pi-act-ii', { act: 'II', section: 'What' }),

  quote('pi-quote-thesis', {
    text: 'A deck should be composition + content + a small overrides pack — not a system rebuild.',
    attribution: 'pulsar',
  }),

  definitionTable('pi-defs-layers', {
    eyebrow: 'three layers',
    title: 'The system makes the deck cheap.',
    rows: [
      {
        cat: 'L1 — Engine',
        rule: 'scene contract, composition resolver, GSAP, audio, navigation, validation.',
        mod: 'green',
      },
      {
        cat: 'L2 — System',
        rule: 'tokens, chrome pack, scene templates, transitions, presenter UX.',
        mod: 'amber',
      },
      {
        cat: 'L3 — Deck',
        rule: 'composition manifest + per-scene content + small token overrides.',
        mod: 'clear',
      },
    ],
  }),

  introGrid('pi-grid-templates', {
    title: 'The L2 template library.',
    roles: [
      { role: 'titleSlam', primary: true },
      { role: 'actHeader' },
      { role: 'centerpiece' },
      { role: 'statBig / statRow / statPairGrid' },
      { role: 'quote / quoteStack' },
      { role: 'bulletList' },
      { role: 'introGrid / definitionTable' },
      { role: 'compare / screenshotCallouts' },
      { role: 'metricTicker / terminal / placard / outlineTitle / outro', primary: true },
    ],
  }),

  outlineTitle('pi-outline-iii', { index: 3, title: 'How it composes' }),

  statRow('pi-stats-savings', {
    eyebrow: 'before & after',
    title: 'A second deck is hours, not days.',
    rows: [
      ['~12k → ~1k', 'lines of authored code per deck'],
      ['~50 → ~12', 'templates the author needs to know'],
      ['0 → 18', 'shipped template factories'],
      ['0 → 5', 'shipped inter-scene transitions'],
      ['hand-roll', 'replaced by `import { titleSlam } from `pulsar/system`'],
    ],
  }),

  statPairGrid('pi-grid-stats', {
    eyebrow: 'by the numbers',
    title: 'What this PR ships.',
    pairs: [
      ['18', 'scene templates'],
      ['5', 'inter-scene transitions'],
      ['1', 'opinionated visual register'],
      ['9', 'chrome effect helpers'],
      ['4', 'helper module surfaces'],
    ],
  }),

  compare('pi-compare', {
    headline: 'The asymmetry.',
    left: 'Bespoke: every visual concern re-invented, every keyboard binding hand-wired, every CSS file from scratch. 12k LOC. Weeks per deck.',
    right:
      'Pulsar L2: every visual concern token-driven, every keyboard binding inherited, every scene a template factory call. ~1k LOC of content. Days per deck.',
  }),

  quoteStack('pi-stack-design', {
    eyebrow: 'what made the cut',
    title: 'Design decisions.',
    quotes: [
      {
        text: 'One opinionated visual register — cinematic thriller. Deck-specific overrides at the token level.',
        attribution: 'Visual',
      },
      {
        text: 'Transitions tween a transient overlay, never scene-owned DOM.',
        attribution: 'Runtime',
      },
      {
        text: 'Mount-then-play stays; templates own activation timing on the master.',
        attribution: 'Lifecycle',
      },
    ],
  }),

  metricTicker('pi-ticker-uptime', {
    eyebrow: 'live',
    title: 'Authoring throughput.',
    metrics: [
      { label: 'Templates available', direction: 'up', start: 18, step: 0, suffix: '' },
      { label: 'Decks authored', direction: 'up', start: 1, step: 0, suffix: '' },
      { label: 'Lines per scene', direction: 'down', start: 60, step: 0, suffix: '' },
      { label: 'Per-deck CSS lines', direction: 'down', start: 0, step: 0, suffix: '' },
    ],
  }),

  centerpiece('pi-centerpiece', {
    quote: 'Reuse the engine. Reuse the system. Author the deck.',
    attribution: 'pulsar/L2',
  }),

  outro('pi-outro', {
    title: 'You are watching this deck on the system that built it.',
    subtitle: 'Press → / Space to advance, ← back, P to hold, M to mute, Esc home.',
  }),
];
