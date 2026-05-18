// Pulsar L2 — register token parity test.
//
// Asserts that the CSS custom properties declared in
// `src/system/register/tokens.css` and the names enumerated in
// `CSS_TOKEN_NAMES` in `src/system/register/tokens.ts` stay aligned.
// Adding a token to one side without the other fails this test, so
// downstream consumers (templates that read tokens via TS, decks that
// override via CSS) cannot drift in opposite directions.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CSS_TOKEN_NAMES } from '../../src/system/register/tokens';

const TOKENS_CSS_PATH = join(__dirname, '../../src/system/register/tokens.css');

const parseCssTokens = (css: string): readonly string[] => {
  // Match `--pulsar-<name>: <value>;` declarations inside the `:root`
  // block. Comments are stripped first so a commented-out token does
  // not satisfy a TS export.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const matches = stripped.matchAll(/(--pulsar-[a-z0-9-]+)\s*:/g);
  return [...new Set([...matches].map((m) => m[1] as string))];
};

describe('pulsar register tokens (Batch A)', () => {
  it('every token enumerated in TS is declared in CSS', () => {
    const css = readFileSync(TOKENS_CSS_PATH, 'utf8');
    const cssTokens = new Set(parseCssTokens(css));
    const missing = CSS_TOKEN_NAMES.filter((name) => !cssTokens.has(name));
    expect(
      missing,
      `CSS_TOKEN_NAMES claims these tokens but they are missing from tokens.css: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every token declared in CSS is enumerated in TS', () => {
    const css = readFileSync(TOKENS_CSS_PATH, 'utf8');
    const cssTokens = parseCssTokens(css);
    const tsTokens = new Set(CSS_TOKEN_NAMES);
    const extra = cssTokens.filter((name) => !tsTokens.has(name));
    expect(
      extra,
      `tokens.css declares these tokens but CSS_TOKEN_NAMES is missing them: ${extra.join(', ')}`,
    ).toEqual([]);
  });
});
