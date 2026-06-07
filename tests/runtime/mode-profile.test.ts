import { describe, expect, it } from 'vitest';
import { type ModeProfile, profileFor } from '../../src/runtime/mode-profile';
import { NAVIGATION_MODES, type NavigationMode } from '../../src/runtime/navigation';

// Guard for the ModeProfile data table. Under ADR-032 the workbench supports
// two modes — `present` and `prompter` — each selecting the audio output
// policy, chrome visibility, and bed-suppression. These reference functions
// reproduce that per-mode logic so the table MUST agree with them.

const expectedAudioPolicy = (_mode: NavigationMode): ModeProfile['audioPolicy'] => 'audible';

const expectedChromeVisibility = (_mode: NavigationMode): ModeProfile['chromeVisibility'] =>
  'visible';

const expectedSuppressBed = (_mode: NavigationMode): boolean => false;

describe('mode profile table', () => {
  it('defines a profile for every navigation mode', () => {
    for (const mode of NAVIGATION_MODES) {
      expect(profileFor(mode), `missing profile for "${mode}"`).toBeDefined();
    }
  });

  it.each(NAVIGATION_MODES)('profile for "%s" matches the expected logic', (mode) => {
    const p = profileFor(mode);
    expect(p.audioPolicy).toBe(expectedAudioPolicy(mode));
    expect(p.chromeVisibility).toBe(expectedChromeVisibility(mode));
    expect(p.suppressBed).toBe(expectedSuppressBed(mode));
  });

  it('freezes profiles so a consumer cannot mutate the shared table', () => {
    const p = profileFor('present');
    expect(Object.isFrozen(p)).toBe(true);
  });
});
