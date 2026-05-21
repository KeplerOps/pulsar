import { describe, expect, it } from 'vitest';

import { describeError, describeErrorDetailed, formatSceneContext } from '../../src/runtime/error';

describe('describeError', () => {
  it('returns the .message for an Error instance', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('coerces non-Error values via String()', () => {
    expect(describeError('boom')).toBe('boom');
    expect(describeError(42)).toBe('42');
    expect(describeError(undefined)).toBe('undefined');
    expect(describeError(null)).toBe('null');
    expect(describeError({ toString: () => 'object' })).toBe('object');
  });
});

describe('describeErrorDetailed (PUL-Q009 public-surface renderer)', () => {
  it('matches describeError for a plain Error', () => {
    expect(describeErrorDetailed(new Error('boom'))).toBe('boom');
  });

  it('matches describeError for non-Error values', () => {
    expect(describeErrorDetailed('boom')).toBe('boom');
    expect(describeErrorDetailed(undefined)).toBe('undefined');
  });

  it('renders AggregateError children in declaration order joined with "; "', () => {
    const aggregate = new AggregateError(
      [new Error('asset "/a.png": 404 Not Found'), new Error('asset "/b.json": 500 oops')],
      'composition asset preload failed: scene "intro"',
    );
    expect(describeErrorDetailed(aggregate)).toBe(
      'composition asset preload failed: scene "intro" [asset "/a.png": 404 Not Found; asset "/b.json": 500 oops]',
    );
  });

  it('walks Error.cause and appends with " — cause: " prefix', () => {
    const inner = new Error('inner detail');
    const outer = new Error('outer wrap', { cause: inner });
    expect(describeErrorDetailed(outer)).toBe('outer wrap — cause: inner detail');
  });

  it('walks a cause chain into an AggregateError so wrapped preload failures surface every asset path', () => {
    const aggregate = new AggregateError(
      [new Error('asset "/missing.png": 404 Not Found'), new Error('asset "/broken.json": 500')],
      'composition asset preload failed: scene "intro"',
    );
    const wrapped = new Error(
      'composition resolution failed: scene "intro" preloadAssets threw: composition asset preload failed: scene "intro"',
      { cause: aggregate },
    );
    expect(describeErrorDetailed(wrapped)).toBe(
      'composition resolution failed: scene "intro" preloadAssets threw: composition asset preload failed: scene "intro" — cause: composition asset preload failed: scene "intro" [asset "/missing.png": 404 Not Found; asset "/broken.json": 500]',
    );
  });

  it('renders every aggregate child by default (PUL-Q009: every failing asset path surfaces)', () => {
    // PUL-Q009 says "the runtime SHALL surface the failure with the
    // scene id and asset path"; for a scene that declares many failing
    // assets, "asset path" means every failing path. The default
    // rendering MUST therefore not silently truncate — even when
    // maxBranches is unset the operator sees every declared path.
    const children = Array.from({ length: 25 }, (_, i) => new Error(`asset "/a${i}": 404`));
    const aggregate = new AggregateError(children, 'preload failed');
    const out = describeErrorDetailed(aggregate);
    for (let i = 0; i < children.length; i += 1) {
      expect(out).toContain(`asset "/a${i}": 404`);
    }
    // And no "…+N more" suffix on the default path.
    expect(out).not.toContain('more');
  });

  it('truncates AggregateError branches beyond maxBranches with a "…+N more" suffix', () => {
    const children = Array.from({ length: 12 }, (_, i) => new Error(`asset "/a${i}": 404`));
    const aggregate = new AggregateError(children, 'preload failed');
    expect(describeErrorDetailed(aggregate, { maxBranches: 3 })).toBe(
      'preload failed [asset "/a0": 404; asset "/a1": 404; asset "/a2": 404; …+9 more]',
    );
  });

  it('respects maxDepth: depth 0 collapses to describeError (no cause / no children walked)', () => {
    const aggregate = new AggregateError([new Error('child')], 'outer');
    expect(describeErrorDetailed(aggregate, { maxDepth: 0 })).toBe('outer');
    const wrapped = new Error('wrap', { cause: new Error('cause') });
    expect(describeErrorDetailed(wrapped, { maxDepth: 0 })).toBe('wrap');
  });

  it('renders nested AggregateError within depth budget and truncates beyond it', () => {
    const innerAggregate = new AggregateError([new Error('leaf-1'), new Error('leaf-2')], 'inner');
    const outerAggregate = new AggregateError([innerAggregate, new Error('sibling')], 'outer');
    expect(describeErrorDetailed(outerAggregate)).toBe('outer [inner [leaf-1; leaf-2]; sibling]');
    // Limit recursion: only the outer aggregate's children get walked,
    // the inner one collapses to its own message.
    expect(describeErrorDetailed(outerAggregate, { maxDepth: 1 })).toBe('outer [inner; sibling]');
  });

  it('terminates on a cyclic cause chain via the WeakSet cycle guard, not just the depth bound', () => {
    // Pass an unbounded maxDepth so only the WeakSet cycle guard can
    // stop the walk. The default depth-4 bound would shield the
    // regression: a missing visited-set would still terminate at
    // depth 0 and the assertion would silently pass.
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as Error & { cause?: unknown }).cause = b;
    const out = describeErrorDetailed(a, { maxDepth: Number.POSITIVE_INFINITY });
    expect(out.startsWith('a — cause: b')).toBe(true);
    expect(out.length).toBeLessThan(200);
  });
});

describe('formatSceneContext (PUL-Q006 scene-error context prefix)', () => {
  it('renders the scene id alone when neither phase nor beat is supplied', () => {
    expect(formatSceneContext({ sceneId: 'intro' })).toBe('scene "intro"');
  });

  it('appends `failed during <phase>` when a lifecycle phase is supplied', () => {
    expect(formatSceneContext({ sceneId: 'intro', phase: 'create' })).toBe(
      'scene "intro" failed during create',
    );
    expect(formatSceneContext({ sceneId: 'intro', phase: 'timeline' })).toBe(
      'scene "intro" failed during timeline',
    );
    expect(formatSceneContext({ sceneId: 'intro', phase: 'cleanup' })).toBe(
      'scene "intro" failed during cleanup',
    );
  });

  it('appends `at beat "<beat>"` when a beat label is supplied', () => {
    expect(formatSceneContext({ sceneId: 'intro', beat: 'hook' })).toBe(
      'scene "intro" at beat "hook"',
    );
  });

  it('appends both phase and beat when both are supplied', () => {
    expect(formatSceneContext({ sceneId: 'intro', phase: 'timeline', beat: 'hook' })).toBe(
      'scene "intro" failed during timeline at beat "hook"',
    );
  });
});
