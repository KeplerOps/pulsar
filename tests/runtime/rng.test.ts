import { describe, expect, it } from 'vitest';
import { createSeededRng, hashSeed } from '../../src/runtime/rng';

// PUL-F018 / ADR-021 — deterministic seeded PRNG.
//
// `mode=screenshot` requires "any randomness sourced from a deterministic
// seed" so a given workbench URL renders an identical frame across
// reloads. These tests pin the two properties that guarantee makes:
// the same seed always produces the same sequence, and the generator
// state is scoped to the closure (no cross-instance perturbation).

describe('hashSeed', () => {
  it('is deterministic — the same string always yields the same integer', () => {
    expect(hashSeed('scene-a|intro|0.1.0')).toBe(hashSeed('scene-a|intro|0.1.0'));
    expect(hashSeed('')).toBe(hashSeed(''));
  });

  it('returns a 32-bit unsigned integer', () => {
    for (const input of ['', 'a', 'scene-a|intro|0.1.0', 'composition-x#3|2|1']) {
      const h = hashSeed(input);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });

  it('separates inputs that differ only in one field', () => {
    expect(hashSeed('scene-a|intro|0.1.0')).not.toBe(hashSeed('scene-b|intro|0.1.0'));
    expect(hashSeed('scene-a|intro|0.1.0')).not.toBe(hashSeed('scene-a|outro|0.1.0'));
    expect(hashSeed('scene-a|intro|0.1.0')).not.toBe(hashSeed('scene-a|intro|0.2.0'));
  });
});

describe('createSeededRng', () => {
  const drawN = (rng: () => number, n: number): number[] => Array.from({ length: n }, () => rng());

  it('produces an identical sequence across two invocations with the same seed', () => {
    const a = createSeededRng('scene-a|intro|0.1.0');
    const b = createSeededRng('scene-a|intro|0.1.0');
    expect(drawN(a, 100)).toEqual(drawN(b, 100));
  });

  it('produces a different sequence for a different seed', () => {
    const a = drawN(createSeededRng('scene-a|intro|0.1.0'), 100);
    const b = drawN(createSeededRng('scene-b|intro|0.1.0'), 100);
    expect(a).not.toEqual(b);
  });

  it('yields every draw in the half-open interval [0, 1)', () => {
    const rng = createSeededRng('coverage-seed');
    for (let i = 0; i < 10000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('scopes state to the closure — one generator does not perturb another', () => {
    // Two generators with the same seed. Advancing one must not shift
    // the other: the sequences stay aligned regardless of draw order.
    const a = createSeededRng('shared-seed');
    const b = createSeededRng('shared-seed');
    a();
    a();
    a();
    const next = b();
    // `b` is untouched by `a`'s three draws — its first value equals a
    // fresh generator's first value.
    expect(next).toBe(createSeededRng('shared-seed')());
  });

  it('advances on every call — successive draws differ', () => {
    const rng = createSeededRng('advance-seed');
    const first = rng();
    const second = rng();
    expect(first).not.toBe(second);
  });
});
