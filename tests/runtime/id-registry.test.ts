// Focused tests for the id-registry's `onDuplicate` collector hook.
//
// Default behavior (no callback supplied) is already exercised at the
// scene-registry and composition-registry level — those tests pin the
// fail-fast `<label>: duplicate id "<id>"` throw. This file pins the
// collector path PUL-F028's validation pass relies on: when
// `onDuplicate` is set, the registry invokes the callback once per
// duplicate occurrence (in iteration order) and skips it, leaving the
// first occurrence canonical.

import { describe, expect, it, vi } from 'vitest';
import { type IdRegistryEntry, createIdRegistry } from '../../src/runtime/id-registry';

describe('createIdRegistry — onDuplicate collector hook', () => {
  it('invokes the callback (does not throw) when a duplicate id appears', () => {
    const onDuplicate = vi.fn();
    expect(() =>
      createIdRegistry<number>(
        [
          { id: 'a', value: 1 },
          { id: 'a', value: 2 },
        ],
        {
          label: 'test',
          subject: 'thing',
          validateId: () => undefined,
          onDuplicate,
        },
      ),
    ).not.toThrow();
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    const call = onDuplicate.mock.calls[0]?.[0] as IdRegistryEntry<number>;
    expect(call).toEqual({ id: 'a', value: 2 });
  });

  it('keeps the first occurrence canonical and skips duplicates from registration', () => {
    const onDuplicate = vi.fn();
    const registry = createIdRegistry<number>(
      [
        { id: 'a', value: 1 },
        { id: 'a', value: 2 },
        { id: 'b', value: 3 },
      ],
      {
        label: 'test',
        subject: 'thing',
        validateId: () => undefined,
        onDuplicate,
      },
    );
    expect(registry.size).toBe(2);
    expect(registry.ids()).toEqual(['a', 'b']);
    expect(registry.get('a')).toBe(1);
    expect(registry.get('b')).toBe(3);
  });

  it('invokes the callback once per duplicate occurrence in iteration order', () => {
    const seen: IdRegistryEntry<string>[] = [];
    createIdRegistry<string>(
      [
        { id: 'a', value: 'first' },
        { id: 'a', value: 'second' },
        { id: 'a', value: 'third' },
        { id: 'b', value: 'b1' },
        { id: 'b', value: 'b2' },
      ],
      {
        label: 'test',
        subject: 'thing',
        validateId: () => undefined,
        onDuplicate: (entry) => seen.push(entry),
      },
    );
    expect(seen).toEqual([
      { id: 'a', value: 'second' },
      { id: 'a', value: 'third' },
      { id: 'b', value: 'b2' },
    ]);
  });

  it('still throws on duplicate when no callback is supplied (default fail-fast)', () => {
    expect(() =>
      createIdRegistry<number>(
        [
          { id: 'a', value: 1 },
          { id: 'a', value: 2 },
        ],
        {
          label: 'scene registry',
          subject: 'scene',
          validateId: () => undefined,
        },
      ),
    ).toThrow(/scene registry: duplicate id "a"/);
  });

  it('reports the duplicating value (not the canonical first occurrence)', () => {
    // Confirms the registry hands the callback the entry that was
    // about to register on top of an existing id — i.e., the source
    // location an author needs to remove or rename to fix the dup.
    const collected: IdRegistryEntry<{ marker: string }>[] = [];
    createIdRegistry<{ marker: string }>(
      [
        { id: 'a', value: { marker: 'canonical' } },
        { id: 'a', value: { marker: 'duplicate' } },
      ],
      {
        label: 'test',
        subject: 'thing',
        validateId: () => undefined,
        onDuplicate: (entry) => collected.push(entry),
      },
    );
    expect(collected).toHaveLength(1);
    expect(collected[0]?.value.marker).toBe('duplicate');
  });
});
