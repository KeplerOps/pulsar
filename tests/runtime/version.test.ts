import { describe, expect, it } from 'vitest';
import { PULSAR_RUNTIME_VERSION } from '../../src/runtime/version';

describe('PULSAR_RUNTIME_VERSION', () => {
  it('is a non-empty string', () => {
    expect(typeof PULSAR_RUNTIME_VERSION).toBe('string');
    expect(PULSAR_RUNTIME_VERSION.length).toBeGreaterThan(0);
  });

  it('matches semver major.minor.patch shape', () => {
    expect(PULSAR_RUNTIME_VERSION).toMatch(/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/);
  });
});
