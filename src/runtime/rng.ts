// Deterministic seeded PRNG — PUL-F018 / ADR-021.
//
// `mode=screenshot` requires "any randomness sourced from a deterministic
// seed" so a given workbench URL renders a frame that is identical
// across reloads (PUL-Q001). Scene modules cannot reach for
// `Math.random`, `crypto.getRandomValues`, or any wall-clock primitive
// — the PUL-Q001 source scanner
// (`tests/runtime/screenshot-determinism-source.test.ts`) bans them
// across `src/**`. This module is the sanctioned randomness source: the
// workbench seeds it per scene activation and exposes the resulting
// generator on `WorkbenchSceneCtx.rng`.
//
// The algorithm is `mulberry32` (a 32-bit arithmetic PRNG) seeded
// through an `xmur3` string hash. Both are pure integer arithmetic —
// no ambient entropy, no timing surface — so they produce identical
// sequences on every JavaScript engine, which is exactly what
// determinism across reloads requires.

/**
 * Fold an arbitrary seed string into a 32-bit unsigned integer using
 * the `xmur3` hash. Deterministic and engine-independent: the same
 * string always yields the same integer, and inputs differing in any
 * character diverge. Used to turn the workbench's derived seed string
 * (see {@link import('./scene-loader').deriveNavigationSeed}) into the
 * numeric state {@link createSeededRng} needs.
 */
export function hashSeed(input: string): number {
  let h = 1779033703 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Build a deterministic PRNG seeded from `seed`. The returned closure
 * yields the next float in the half-open interval `[0, 1)` on each
 * call, advancing its own scoped 32-bit state — the `mulberry32`
 * algorithm.
 *
 * Two generators built from the same seed string emit identical
 * sequences (the PUL-F018 reproducibility guarantee). The generator
 * state lives in the returned closure and is never a process-global,
 * so one scene occurrence's draws cannot perturb another's draw order
 * — the scoping the ADR-021 seed/RNG guardrail requires.
 */
export function createSeededRng(seed: string): () => number {
  let state = hashSeed(seed);
  return (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
