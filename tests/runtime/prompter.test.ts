// Prompter captions aggregation — PUL-F019 / ADR-022.
//
// The captions-aggregation seam under `mode=prompter`. Pure function
// over a `SceneNavigationTarget` (already validated by the navigation
// dispatcher) — produces a `PrompterScript` carrying the addressed
// scene's (or composition slice's) `captions` metadata. The future
// captions/script UI surface consumes this shape; the loader hands it
// to a `renderPrompter` adapter without interpreting it.

import { describe, expect, it } from 'vitest';
import { type PrompterScript, buildPrompterScript } from '../../src/runtime/prompter';
import type { Caption, SceneModule } from '../../src/runtime/scene';
import type { SceneNavigationTarget } from '../../src/runtime/scene-navigation';

interface BuildSceneOpts {
  readonly id: string;
  readonly title?: string;
  readonly captions?: readonly Caption[];
}

const buildScene = (opts: BuildSceneOpts): SceneModule => ({
  id: opts.id,
  title: opts.title ?? opts.id,
  duration: 1000,
  tags: [],
  assets: [],
  captions: opts.captions ?? [],
  defaultNext: null,
  standalone: true,
  trailerSafe: false,
  create: () => undefined,
  timeline: () => undefined,
  cleanup: () => undefined,
});

describe('buildPrompterScript (PUL-F019 / ADR-022)', () => {
  it('builds a one-entry script for a single-scene target with no composition field', () => {
    // PUL-F019: "captions metadata of the addressed scene OR
    // composition." Single-scene addressing carries no composition
    // context — `composition` is absent on the script. The entry's
    // captions come from the scene module's metadata unchanged.
    const intro = buildScene({
      id: 'intro',
      title: 'Intro',
      captions: [
        { at: 0, text: 'Hello' },
        { at: 1500, text: 'World' },
      ],
    });
    const target: SceneNavigationTarget = { scene: intro };

    const script = buildPrompterScript(target);

    expect(script).toEqual({
      entries: [
        {
          sceneId: 'intro',
          title: 'Intro',
          captions: [
            { at: 0, text: 'Hello' },
            { at: 1500, text: 'World' },
          ],
        },
      ],
    });
    expect('composition' in script).toBe(false);
  });

  it('aggregates captions across the FULL composition slice (NOT truncated to head)', () => {
    // PUL-F019 explicitly says "addressed scene OR composition." Under
    // a composition target the captions view's purpose is to show every
    // scene's captions in manifest order. This is the structural
    // difference from `mode=loop` / `mode=paused` / `mode=scrub` /
    // `mode=screenshot`, which truncate the slice to the head — under
    // those modes the head's runner-side semantic implies "no following
    // entries run" and truncating is the structural defense. Under
    // prompter the lifecycle doesn't run AT ALL (visual rendering is
    // suppressed structurally), so there is no analogous defense to
    // apply; the captions data path consumes the full slice. A
    // regression that copy-pasted truncation from the other modes
    // would silently drop tail-scene captions from the prompter view.
    const intro = buildScene({
      id: 'intro',
      title: 'Intro',
      captions: [{ at: 0, text: 'A' }],
    });
    const middle = buildScene({
      id: 'middle',
      title: 'Middle',
      captions: [{ at: 0, text: 'B' }],
    });
    const outro = buildScene({
      id: 'outro',
      title: 'Outro',
      captions: [{ at: 0, text: 'C' }],
    });
    const target: SceneNavigationTarget = {
      scene: intro,
      composition: {
        id: 'full-talk',
        manifestSlice: ['intro', 'middle', 'outro'],
        sceneSlice: [intro, middle, outro],
      },
    };

    const script = buildPrompterScript(target);

    expect(script).toEqual({
      composition: { id: 'full-talk' },
      entries: [
        { sceneId: 'intro', title: 'Intro', captions: [{ at: 0, text: 'A' }] },
        { sceneId: 'middle', title: 'Middle', captions: [{ at: 0, text: 'B' }] },
        { sceneId: 'outro', title: 'Outro', captions: [{ at: 0, text: 'C' }] },
      ],
    });
  });

  it('starts the slice at the addressed scene under composition+scene targeting (non-head)', () => {
    // The dispatcher already snapshotted the slice from the addressed
    // scene onward (PUL-F008 / ADR-014). `buildPrompterScript`
    // honors that slice as-is — it does NOT walk back to the
    // composition's first entry. A regression that re-resolved from
    // the composition's start would surface tail captions that the
    // navigation explicitly skipped. Pin the addressed-onward
    // behavior with a non-head start so the test would fail if the
    // function regressed to "always full composition."
    const intro = buildScene({ id: 'intro', captions: [{ at: 0, text: 'skipped' }] });
    const middle = buildScene({
      id: 'middle',
      title: 'Middle',
      captions: [{ at: 0, text: 'kept' }],
    });
    const outro = buildScene({ id: 'outro', captions: [{ at: 0, text: 'also kept' }] });
    void intro; // referenced by the manifest position the dispatcher already trimmed away
    const target: SceneNavigationTarget = {
      scene: middle,
      composition: {
        id: 'full-talk',
        manifestSlice: ['middle', 'outro'],
        sceneSlice: [middle, outro],
      },
    };

    const script = buildPrompterScript(target);

    expect(script.composition?.id).toBe('full-talk');
    expect(script.entries.map((e) => e.sceneId)).toEqual(['middle', 'outro']);
    expect(script.entries[0]?.captions).toEqual([{ at: 0, text: 'kept' }]);
  });

  it('carries mixed numeric and beat-label "at" values through the script entries unchanged (PUL-F027)', () => {
    // PUL-F027: `Caption.at` is a union of `number` (ms offset) and
    // `string` (kebab-case beat label). The runtime SHALL derive the
    // prompter view from this same metadata — `buildPrompterScript`
    // does NOT coerce, sort, drop, or rewrite `at` based on its type.
    // A regression that normalized all `at` values to milliseconds in
    // the prompter path would lose authored beat-label semantics for
    // consumers (caption editor, beat-aware UI, exporter) that
    // discriminate by `typeof`.
    const intro = buildScene({
      id: 'intro',
      title: 'Intro',
      captions: [
        { at: 0, text: 'opening' },
        { at: 'hook', text: 'beat-labelled' },
        { at: 4000, text: 'numeric again' },
        { at: 'midpoint-stinger', text: 'multi-segment label' },
      ],
    });
    const target: SceneNavigationTarget = { scene: intro };

    const script = buildPrompterScript(target);

    expect(script.entries[0]?.captions).toEqual([
      { at: 0, text: 'opening' },
      { at: 'hook', text: 'beat-labelled' },
      { at: 4000, text: 'numeric again' },
      { at: 'midpoint-stinger', text: 'multi-segment label' },
    ]);
  });

  it('preserves all Caption fields structurally (no parallel { at, text } schema)', () => {
    // PUL-F001 declares `Caption` with `at` and `text` today.
    // Future fields (e.g. a `speaker` annotation, an `id` for
    // clickable highlights) MUST flow through the prompter script
    // unchanged — the captions seam reads scene metadata
    // structurally, not field-by-field. A regression that
    // hard-coded `{ at: c.at, text: c.text }` would silently drop
    // any field the script consumer expected. This test injects a
    // forward-compatible field via type assertion (production
    // `Caption` shape doesn't have it yet, but the runtime path
    // must not strip it).
    const sourceCaption = { at: 0, text: 'one', speaker: 'host' } as Caption & {
      speaker: string;
    };
    const intro = buildScene({ id: 'intro', captions: [sourceCaption] });
    const target: SceneNavigationTarget = { scene: intro };

    const script = buildPrompterScript(target);

    expect(script.entries[0]?.captions[0]).toEqual({ at: 0, text: 'one', speaker: 'host' });
  });

  it('carries object-form composition entry overrides (range, behavior) on the script entry as optional metadata', () => {
    // ADR-002 / PUL-F003 — object-form entries on the manifest
    // carry `range` and `behavior` overrides. Captions themselves
    // come from the scene's full metadata regardless of `range`
    // (the runner is the only consumer that resolves named beats
    // to timeline positions; the captions data path has no
    // timeline to filter against). But dropping the manifest
    // overrides entirely would leave the captions UI unable to
    // communicate "this entry plays the `midpoint` sub-range" to
    // the reviewer. Pin the metadata-passthrough explicitly.
    const middle = buildScene({
      id: 'middle',
      title: 'Middle',
      captions: [{ at: 0, text: 'one' }],
    });
    const target: SceneNavigationTarget = {
      scene: middle,
      composition: {
        id: 'full-talk',
        manifestSlice: [{ id: 'middle', range: 'midpoint', behavior: { hold: true } }],
        sceneSlice: [middle],
      },
    };

    const script = buildPrompterScript(target);

    expect(script.entries).toHaveLength(1);
    expect(script.entries[0]?.range).toBe('midpoint');
    expect(script.entries[0]?.behavior).toEqual({ hold: true });
    expect(script.entries[0]?.captions).toEqual([{ at: 0, text: 'one' }]);
  });

  it('omits range / behavior fields for bare-string composition entries and direct-scene targets', () => {
    // The optional metadata fields stay absent (not `undefined`)
    // when the manifest entry is a bare string OR when the
    // navigation target has no composition. A regression that set
    // `range: undefined` would change `'range' in entry` from
    // false to true, surprising future captions-UI code that
    // branches on key presence.
    const sceneA = buildScene({ id: 'scene-a', title: 'Alpha' });
    const sceneB = buildScene({ id: 'scene-b', title: 'Bravo' });
    const compositionTarget: SceneNavigationTarget = {
      scene: sceneA,
      composition: {
        id: 'full-talk',
        manifestSlice: ['scene-a', 'scene-b'],
        sceneSlice: [sceneA, sceneB],
      },
    };
    const directTarget: SceneNavigationTarget = { scene: sceneA };

    const compositionScript = buildPrompterScript(compositionTarget);
    const directScript = buildPrompterScript(directTarget);

    expect(compositionScript.entries.every((e) => !('range' in e) && !('behavior' in e))).toBe(
      true,
    );
    expect('range' in (directScript.entries[0] as object)).toBe(false);
    expect('behavior' in (directScript.entries[0] as object)).toBe(false);
  });

  it('reads captions from the registered scene module under object-form composition entries (range / behavior overrides do not alter captions)', () => {
    // ADR-002 / ADR-011: object-form entries override the runner's
    // sub-range and behavior knobs. They do NOT carry caption
    // overrides — captions live on the scene module's metadata, and
    // prompter shows the scene's captions verbatim regardless of
    // which sub-range the runner would have played. A regression
    // that read captions from the entry instead of the registered
    // scene would either crash on `entry.captions` (undefined) or
    // silently produce empty captions for object-form entries.
    const middle = buildScene({
      id: 'middle',
      title: 'Middle',
      captions: [
        { at: 0, text: 'one' },
        { at: 500, text: 'two' },
      ],
    });
    const target: SceneNavigationTarget = {
      scene: middle,
      composition: {
        id: 'full-talk',
        manifestSlice: [{ id: 'middle', range: 'midpoint', behavior: { hold: true } }],
        sceneSlice: [middle],
      },
    };

    const script = buildPrompterScript(target);

    expect(script.entries).toHaveLength(1);
    expect(script.entries[0]?.captions).toEqual([
      { at: 0, text: 'one' },
      { at: 500, text: 'two' },
    ]);
  });

  it('emits an empty captions array when the scene declares no captions', () => {
    // The placeholder scene declares `captions: []`; lots of in-flight
    // scenes will too while the prompter UI is being designed. The
    // prompter script must accept that as a real-world shape rather
    // than treating "empty captions" as a degenerate case the future
    // UI has to special-case.
    const blank = buildScene({ id: 'blank', captions: [] });
    const target: SceneNavigationTarget = { scene: blank };

    const script = buildPrompterScript(target);

    expect(script.entries[0]?.captions).toEqual([]);
  });

  it('returns a deep-frozen script so the future captions UI cannot mutate the source metadata', () => {
    // `Caption` is `interface Caption { at; text }` — it is NOT
    // declared as `readonly` on the source side because scene modules
    // can be authored as plain objects. The prompter-script seam is
    // the boundary the future UI consumes; freezing here means a
    // misbehaving renderer that pushes onto `script.entries` or
    // mutates `entries[0].captions[0].text` fails fast rather than
    // silently corrupting the next navigation's view.
    const intro = buildScene({
      id: 'intro',
      captions: [{ at: 0, text: 'mutable-source' }],
    });
    const target: SceneNavigationTarget = { scene: intro };

    const script: PrompterScript = buildPrompterScript(target);

    expect(Object.isFrozen(script)).toBe(true);
    expect(Object.isFrozen(script.entries)).toBe(true);
    expect(Object.isFrozen(script.entries[0])).toBe(true);
    expect(Object.isFrozen(script.entries[0]?.captions)).toBe(true);
  });

  it('does not mutate or freeze the source scene module (deep-clone captions, not shallow-copy)', () => {
    // The first regression a shallow `[...scene.captions]` copy
    // would NOT catch: `deepFreeze` walks the spread array and
    // freezes every `Caption` it encounters; those Caption objects
    // are still shared with the source scene's `captions` array,
    // so the source scene module's individual caption objects end
    // up frozen even though the array itself is not. Production
    // code that legitimately mutates a Caption elsewhere (e.g. a
    // future caption editor, a test fixture rebuilding scene
    // metadata) would crash silently. Pin BOTH the array AND the
    // individual caption objects as unfrozen and independently
    // mutable after `buildPrompterScript` runs.
    const sourceCaption: Caption = { at: 0, text: 'original' };
    const captions: Caption[] = [sourceCaption];
    const intro: SceneModule = {
      ...buildScene({ id: 'intro' }),
      captions,
    };
    const target: SceneNavigationTarget = { scene: intro };

    buildPrompterScript(target);

    expect(Object.isFrozen(captions)).toBe(false);
    expect(Object.isFrozen(sourceCaption)).toBe(false);
    // The source caption object remains independently mutable —
    // proves no frozen reference leaked through the script's deep
    // freeze.
    sourceCaption.text = 'mutated';
    expect(captions[0]?.text).toBe('mutated');
  });

  it('isolates the script entries from the source — mutating script captions does not affect source captions', () => {
    // The other half of the deep-clone contract: the script must be
    // a defensive copy in BOTH directions. A regression that
    // returned the source `Caption` references in the script
    // (without cloning) would let a misbehaving renderer that
    // bypassed the freeze (e.g. via `Object.assign` shenanigans, or
    // a `--harmony-flag-disabled-freeze` runtime) corrupt the
    // source scene's captions. Even though the freeze is the
    // primary defense, deep-cloning makes the isolation robust to
    // freeze bypass.
    const sourceCaption: Caption = { at: 0, text: 'source' };
    const intro = buildScene({ id: 'intro', captions: [sourceCaption] });
    const target: SceneNavigationTarget = { scene: intro };

    const script = buildPrompterScript(target);

    expect(script.entries[0]?.captions[0]).not.toBe(sourceCaption);
    expect(script.entries[0]?.captions[0]).toEqual(sourceCaption);
  });
});
