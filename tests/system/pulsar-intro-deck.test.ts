// Pulsar L2 — pulsar-intro reference deck shape tests.
//
// Asserts the deck exports a non-empty scene array, every scene
// satisfies the SceneModule contract, every composition entry id
// references a registered scene, every scene declares at least one
// caption (so `?mode=prompter` produces a speaker view), and the
// composition uses more than one transition kind.

import { describe, expect, it } from 'vitest';
import {
  PULSAR_INTRO_COMPOSITION_ID,
  PULSAR_INTRO_SCENES,
  pulsarIntroComposition,
  pulsarIntroCompositionEntry,
} from '../../src/decks/pulsar-intro';
import { assertSceneModule } from '../../src/runtime/scene';

describe('pulsar-intro reference deck', () => {
  it('exports a non-empty scene array', () => {
    expect(PULSAR_INTRO_SCENES.length).toBeGreaterThan(0);
  });

  it('every scene satisfies the SceneModule contract', () => {
    for (const scene of PULSAR_INTRO_SCENES) {
      expect(() => assertSceneModule(scene)).not.toThrow();
    }
  });

  it('every scene id is unique', () => {
    const ids = new Set(PULSAR_INTRO_SCENES.map((s) => s.id));
    expect(ids.size).toBe(PULSAR_INTRO_SCENES.length);
  });

  it('every scene declares at least one caption', () => {
    for (const scene of PULSAR_INTRO_SCENES) {
      expect(scene.captions.length, `${scene.id} captions`).toBeGreaterThan(0);
    }
  });

  it('exports the canonical composition id', () => {
    expect(PULSAR_INTRO_COMPOSITION_ID).toBe('pulsar-intro');
    expect(pulsarIntroCompositionEntry.id).toBe(PULSAR_INTRO_COMPOSITION_ID);
  });

  it('every composition entry id references a registered scene', () => {
    const sceneIds = new Set(PULSAR_INTRO_SCENES.map((s) => s.id));
    for (const entry of pulsarIntroComposition) {
      const id = typeof entry === 'string' ? entry : entry.id;
      expect(sceneIds.has(id), `${id} must be a registered scene`).toBe(true);
    }
  });

  it('the composition uses more than one transition kind', () => {
    const used = new Set<string>();
    for (const entry of pulsarIntroComposition) {
      if (typeof entry === 'string') continue;
      const transition = (entry.behavior as { transition?: { name: string } } | undefined)
        ?.transition;
      if (transition !== undefined) used.add(transition.name);
    }
    expect(used.size, 'composition transition kinds').toBeGreaterThan(1);
  });

  it('first composition entry resolves to a registered scene', () => {
    const head = pulsarIntroComposition[0];
    expect(head).toBeDefined();
    if (head === undefined) return;
    const id = typeof head === 'string' ? head : head.id;
    expect(PULSAR_INTRO_SCENES.find((s) => s.id === id)).toBeDefined();
  });
});
