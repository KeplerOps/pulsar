// ACES ecosystem intro deck shape tests.

import { describe, expect, it } from 'vitest';
import {
  ACES_ECOSYSTEM_INTRO_COMPOSITION_ID,
  ACES_ECOSYSTEM_INTRO_SCENES,
  acesEcosystemIntroComposition,
  acesEcosystemIntroCompositionEntry,
} from '../../src/decks/aces-ecosystem-intro';
import { assertSceneModule } from '../../src/runtime/scene';

describe('aces ecosystem intro deck', () => {
  it('exports a non-empty scene array', () => {
    expect(ACES_ECOSYSTEM_INTRO_SCENES.length).toBeGreaterThan(0);
  });

  it('every scene satisfies the SceneModule contract', () => {
    for (const scene of ACES_ECOSYSTEM_INTRO_SCENES) {
      expect(() => assertSceneModule(scene)).not.toThrow();
    }
  });

  it('every scene id is unique', () => {
    const ids = new Set(ACES_ECOSYSTEM_INTRO_SCENES.map((s) => s.id));
    expect(ids.size).toBe(ACES_ECOSYSTEM_INTRO_SCENES.length);
  });

  it('every scene declares at least one caption', () => {
    for (const scene of ACES_ECOSYSTEM_INTRO_SCENES) {
      expect(scene.captions.length, `${scene.id} captions`).toBeGreaterThan(0);
    }
  });

  it('exports the canonical composition id', () => {
    expect(ACES_ECOSYSTEM_INTRO_COMPOSITION_ID).toBe('aces-ecosystem-intro');
    expect(acesEcosystemIntroCompositionEntry.id).toBe(ACES_ECOSYSTEM_INTRO_COMPOSITION_ID);
  });

  it('every composition entry id references a registered scene', () => {
    const sceneIds = new Set(ACES_ECOSYSTEM_INTRO_SCENES.map((s) => s.id));
    for (const entry of acesEcosystemIntroComposition) {
      const id = typeof entry === 'string' ? entry : entry.id;
      expect(sceneIds.has(id), `${id} must be a registered scene`).toBe(true);
    }
  });

  it('keeps the non-claim visible in the deck', () => {
    const nonClaim = ACES_ECOSYSTEM_INTRO_SCENES.find((scene) => scene.id === 'aces-non-claim');
    expect(nonClaim?.captions.map((c) => c.text).join(' ')).toMatch(/Motivation is not validation/);
  });

  it('does not opt into the cinematic chrome atmosphere', () => {
    for (const entry of acesEcosystemIntroComposition) {
      if (typeof entry === 'string') continue;
      const chrome = (entry.behavior as { chrome?: unknown } | undefined)?.chrome;
      expect(chrome).not.toEqual({ atmosphere: 'cinematic' });
    }
  });

  it('briefing register uses only cut and dissolve transitions', () => {
    const allowed = new Set(['cut', 'dissolve']);
    for (const entry of acesEcosystemIntroComposition) {
      if (typeof entry === 'string') continue;
      const transition = (entry.behavior as { transition?: { name: string } } | undefined)
        ?.transition;
      if (transition === undefined) continue;
      expect(allowed.has(transition.name), `transition ${transition.name}`).toBe(true);
    }
  });
});
