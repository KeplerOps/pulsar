// Tests for the workbench DOM-backed audio-unlock adapter — PUL-F030
// / ADR-029. The codex cycle-3 review flagged that the inline adapter
// in `src/main.ts` was not covered by the gate test suite; this file
// pins the click/abort/cleanup contract against the factory shape
// (`src/runtime/audio-unlock-dom.ts`) so `main.ts`'s thin wiring stays
// the only untestable surface (it just supplies `document.createElement`
// and `document.querySelector('#stage')`).

import { describe, expect, it } from 'vitest';
import {
  type DomAudioUnlockHost,
  type UnlockButtonElement,
  type UnlockMount,
  createDomAudioUnlockAdapter,
} from '../../src/runtime/audio-unlock-dom';
import type { AudioUnlockContext } from '../../src/runtime/scene-loader';

interface FakeButton extends UnlockButtonElement {
  click(): void;
  readonly removeCount: () => number;
}

const buildFakeButton = (): FakeButton => {
  let clickHandler: (() => void) | null = null;
  let removeCount = 0;
  return {
    addEventListener(_event: 'click', handler: () => void): void {
      clickHandler = handler;
    },
    removeEventListener(): void {
      clickHandler = null;
    },
    remove(): void {
      removeCount += 1;
    },
    click(): void {
      clickHandler?.();
    },
    removeCount: () => removeCount,
  };
};

interface FakeMount {
  readonly mount: UnlockMount;
  readonly appended: readonly UnlockButtonElement[];
}

const buildFakeMount = (): FakeMount => {
  const appended: UnlockButtonElement[] = [];
  return {
    mount: (node) => {
      appended.push(node);
    },
    get appended(): readonly UnlockButtonElement[] {
      return appended;
    },
  };
};

const buildGate = (
  unlockBehavior: 'resolve' | 'reject' | 'park' = 'resolve',
): {
  readonly gate: AudioUnlockContext;
  readonly controller: AbortController;
  readonly unlockCalls: () => number;
  readonly resolveUnlock: () => void;
  readonly rejectUnlock: (err: Error) => void;
} => {
  let unlockCalls = 0;
  const controller = new AbortController();
  let resolveUnlock: () => void = () => undefined;
  let rejectUnlock: (err: Error) => void = () => undefined;
  return {
    controller,
    unlockCalls: () => unlockCalls,
    resolveUnlock: () => resolveUnlock(),
    rejectUnlock: (err) => rejectUnlock(err),
    gate: {
      compositionId: 'show',
      sceneIds: Object.freeze(['scene-a']),
      signal: controller.signal,
      unlock: () => {
        unlockCalls += 1;
        if (unlockBehavior === 'resolve') return Promise.resolve();
        if (unlockBehavior === 'reject') return Promise.reject(new Error('unlock failed'));
        return new Promise<void>((res, rej) => {
          resolveUnlock = res;
          rejectUnlock = rej;
        });
      },
    },
  };
};

const buildHost = (
  mount: UnlockMount | null,
  button: FakeButton,
): DomAudioUnlockHost & { readonly button: FakeButton } => ({
  mount,
  createButton: () => button,
  button,
});

const hostFromFake = (
  fake: FakeMount,
  button: FakeButton,
): DomAudioUnlockHost & { readonly button: FakeButton } => buildHost(fake.mount, button);

describe('createDomAudioUnlockAdapter (PUL-F030 / ADR-029)', () => {
  it('rejects immediately when mount is null (no gesture surface available)', async () => {
    const adapter = createDomAudioUnlockAdapter({
      mount: null,
      createButton: () => buildFakeButton(),
    });
    const { gate } = buildGate('resolve');
    await expect(adapter(gate)).rejects.toThrow(/no mount element/);
  });

  it('rejects immediately when the navigation signal is already aborted', async () => {
    const button = buildFakeButton();
    const mount = buildFakeMount();
    const adapter = createDomAudioUnlockAdapter(hostFromFake(mount, button));
    const { gate, controller } = buildGate('resolve');
    controller.abort();
    await expect(adapter(gate)).rejects.toThrow(/aborted/);
    expect(mount.appended).toHaveLength(0);
  });

  it('mounts the button, awaits the click, calls gate.unlock(), removes the button, and resolves', async () => {
    const button = buildFakeButton();
    const mount = buildFakeMount();
    const adapter = createDomAudioUnlockAdapter(hostFromFake(mount, button));
    const { gate, unlockCalls } = buildGate('resolve');
    const promise = adapter(gate);
    expect(mount.appended).toEqual([button]);
    expect(unlockCalls()).toBe(0);
    button.click();
    await expect(promise).resolves.toBeUndefined();
    expect(unlockCalls()).toBe(1);
    expect(button.removeCount()).toBe(1);
  });

  it('rejects with the gate.unlock() error when the engine unlock rejects, and removes the button', async () => {
    const button = buildFakeButton();
    const mount = buildFakeMount();
    const adapter = createDomAudioUnlockAdapter(hostFromFake(mount, button));
    const { gate } = buildGate('reject');
    const promise = adapter(gate);
    button.click();
    await expect(promise).rejects.toThrow(/unlock failed/);
    expect(button.removeCount()).toBe(1);
  });

  it('rejects when the signal aborts while waiting for the user gesture, and removes the button', async () => {
    const button = buildFakeButton();
    const mount = buildFakeMount();
    const adapter = createDomAudioUnlockAdapter(hostFromFake(mount, button));
    const { gate, controller } = buildGate('park');
    const promise = adapter(gate);
    controller.abort();
    await expect(promise).rejects.toThrow(/aborted/);
    expect(button.removeCount()).toBe(1);
  });

  it('rejects when the signal aborts while gate.unlock() is pending (abort wins the race)', async () => {
    const button = buildFakeButton();
    const mount = buildFakeMount();
    const adapter = createDomAudioUnlockAdapter(hostFromFake(mount, button));
    const { gate, controller, unlockCalls, resolveUnlock } = buildGate('park');
    const promise = adapter(gate);
    button.click();
    expect(unlockCalls()).toBe(1);
    // gate.unlock() is parked; now abort the navigation.
    controller.abort();
    // The unlock then-callback should bail on `settled` when it later
    // resolves; verify the adapter rejects via the abort path.
    await expect(promise).rejects.toThrow(/aborted/);
    // Even if we now resolve the pending unlock, the adapter has
    // already settled — no double-resolve, no further side effect.
    resolveUnlock();
    expect(button.removeCount()).toBe(1);
  });

  it('ignores the unlock resolution when the adapter already settled via abort', async () => {
    const button = buildFakeButton();
    const mount = buildFakeMount();
    const adapter = createDomAudioUnlockAdapter(hostFromFake(mount, button));
    const { gate, controller, resolveUnlock } = buildGate('park');
    const promise = adapter(gate);
    button.click();
    controller.abort();
    // Now resolve the engine-bound unlock AFTER abort — the adapter
    // should remain rejected with the abort error.
    resolveUnlock();
    await expect(promise).rejects.toThrow(/aborted/);
  });
});
