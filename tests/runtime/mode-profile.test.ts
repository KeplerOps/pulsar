import { describe, expect, it } from 'vitest';
import { type ModeProfile, profileFor } from '../../src/runtime/mode-profile';
import { NAVIGATION_MODES, type NavigationMode } from '../../src/runtime/navigation';

// Snapshot-equivalence guard for the ModeProfile data table.
//
// Before the table, the per-mode behaviors lived as scattered
// `mode === X` branches in scene-loader.ts and workbench-chrome.ts.
// These reference implementations reproduce that prior logic verbatim;
// the table MUST agree with them for every mode, so this test is the
// proof the centralization changed no behavior.

const expectedAudioPolicy = (mode: NavigationMode): ModeProfile['audioPolicy'] => {
  if (mode === 'rehearsal') return 'log-cues';
  if (mode === 'screenshot' || mode === 'paused') return 'silent';
  return 'audible';
};

const expectedChromeVisibility = (mode: NavigationMode): ModeProfile['chromeVisibility'] =>
  mode === 'standalone' || mode === 'screenshot' ? 'hidden' : 'visible';

const expectedSingleScene = (mode: NavigationMode): boolean =>
  mode === 'standalone' ||
  mode === 'loop' ||
  mode === 'paused' ||
  mode === 'scrub' ||
  mode === 'screenshot';

const expectedSuppressBed = (mode: NavigationMode): boolean => mode === 'standalone';

const expectedBuildScrubCueGate = (mode: NavigationMode): boolean => mode === 'scrub';

const expectedRunnerHints = (mode: NavigationMode): ModeProfile['runnerHints'] => {
  if (mode === 'loop') return { repeat: 'until-aborted' };
  if (mode === 'paused') return { hold: 'first-frame' };
  if (mode === 'scrub') return { cueGate: 'monotonic-forward' };
  if (mode === 'screenshot') return { screenshot: 'capture' };
  return {};
};

describe('mode profile table', () => {
  it('defines a profile for every navigation mode', () => {
    for (const mode of NAVIGATION_MODES) {
      expect(profileFor(mode), `missing profile for "${mode}"`).toBeDefined();
    }
  });

  it.each(NAVIGATION_MODES)('profile for "%s" matches the prior scattered logic', (mode) => {
    const p = profileFor(mode);
    expect(p.audioPolicy).toBe(expectedAudioPolicy(mode));
    expect(p.chromeVisibility).toBe(expectedChromeVisibility(mode));
    expect(p.singleScene).toBe(expectedSingleScene(mode));
    expect(p.suppressBed).toBe(expectedSuppressBed(mode));
    expect(p.buildScrubCueGate).toBe(expectedBuildScrubCueGate(mode));
    expect(p.runnerHints).toEqual(expectedRunnerHints(mode));
  });

  it('at most one runner hint is set per mode (modes are mutually exclusive at the URL boundary)', () => {
    for (const mode of NAVIGATION_MODES) {
      const set = Object.values(profileFor(mode).runnerHints).filter((v) => v !== undefined);
      expect(set.length, `"${mode}" sets more than one runner hint`).toBeLessThanOrEqual(1);
    }
  });

  it('freezes profiles so a consumer cannot mutate the shared table', () => {
    const p = profileFor('loop');
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.runnerHints)).toBe(true);
  });
});
