/** @vitest-environment happy-dom */
// Pulsar L2 template — terminal rendering + lifecycle coverage.
//
// terminal-audio.test.ts already covers the standalone audio helper
// (`startTerminalAudio`) and the factory's assets/audio declarations.
// This file complements it on the RENDERING + LIFECYCLE surface that
// only runs when `playScript` executes against a real DOM:
//
//   - every `TerminalStep` kind renders its own line element + classes
//     (user/agent typed lines, tool name+args / tool text, output
//     text / output lines, popout, wait, wait_counter + fast-forward)
//   - `[[glow]]` markers reveal as `.glow` spans (typed) / `.glow`
//     HTML (output)
//   - opt-in chrome (clock + srcMark) mounts onto `document.body`
//   - the timeline authors the canonical activation envelope
//     (term-start label, advance gate, activation marker flip)
//   - `onDeactivate` (suffix-tween onComplete) strips the body-mounted
//     chrome when master leaves the segment
//   - `cleanup` removes the scene root AND strips body chrome
//
// `playScript` is fired by firing the real GSAP timeline's leading
// `tl.call` via `tl.pause()` + `tl.seek(0.001, false)` (so the live
// ticker never auto-runs); the async step loop is then drained with
// fake timers (`aSleep` / `typeNode` / `schedule` are all
// setTimeout-based). GSAP wakes its real-time ticker on every seek, so
// each helper re-parks it (`gsap.ticker.sleep()`) before draining.

import { gsap } from 'gsap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { terminal } from '../../src/system/templates';

interface TermCtx {
  readonly stage: HTMLElement;
  readonly mode: 'present';
  readonly gsap: typeof gsap;
}

const makeCtx = (): TermCtx => ({ stage: document.createElement('div'), mode: 'present', gsap });

const requireEl = (node: Element | null | undefined, message: string): HTMLElement => {
  expect(node, message).not.toBeNull();
  expect(node, message).toBeDefined();
  if (node === null || node === undefined) throw new Error(message);
  return node as HTMLElement;
};

const findRoot = (ctx: TermCtx, id: string): HTMLElement =>
  requireEl(
    ctx.stage.querySelector(`[data-pulsar-template="${id}"]`),
    `expected terminal root for ${id}`,
  );

const findTerm = (ctx: TermCtx, id: string): HTMLElement =>
  requireEl(findRoot(ctx, id).querySelector('.term'), `expected .term <pre> for ${id}`);

/**
 * Build the scene's timeline and fire its leading activation +
 * `playScript` callbacks WITHOUT auto-running the GSAP ticker.
 *
 * `tl.pause()` then `tl.seek(0.001, false)` fires the time-0
 * `tl.call(() => playScript(...))` (suppressEvents=false) while the
 * timeline stays paused — so the only timers that subsequently advance
 * under fake timers are the template's own setTimeout-driven
 * typing/dwell loop. Driving the timeline via the live GSAP ticker
 * instead would burn real wall-clock time and time the suite out.
 */
const buildAndFire = (scene: ReturnType<typeof terminal>, ctx: TermCtx): gsap.core.Timeline => {
  const tl = scene.timeline(ctx) as gsap.core.Timeline;
  expect(tl, 'expected a real timeline').not.toBeNull();
  tl.pause();
  tl.seek(0.001, false);
  // `seek` wakes GSAP's real-time ticker (rAF / setTimeout fallback);
  // left awake, `advanceTimersByTimeAsync` pumps it and the suite times
  // out. Park it again so only the template's own setTimeout-driven
  // typing/dwell timers advance.
  gsap.ticker.sleep();
  return tl;
};

/** Advance fake timers to drain the async step loop, re-parking the GSAP ticker after. */
const drain = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
  gsap.ticker.sleep();
};

/** Seek to the timeline end (fires the suffix onComplete) without waking the ticker into the next drain. */
const complete = (tl: gsap.core.Timeline): void => {
  tl.progress(1);
  gsap.ticker.sleep();
};

/** Remove any body-mounted chrome a prior test may have left behind. */
const scrubBody = (): void => {
  for (const node of document.body.querySelectorAll(
    '.ph-clock, .src-mark, .ph-popout, .ff-symbol, .ff-tracking',
  )) {
    node.remove();
  }
};

describe('terminal — rendering + lifecycle coverage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    scrubBody();
  });

  it('create mounts a <pre class="term"> inside an inactive terminal root', () => {
    const ctx = makeCtx();
    const scene = terminal('term-mount', { script: [{ t: 'user', text: 'ls' }] });
    scene.create(ctx);

    const root = findRoot(ctx, 'term-mount');
    expect(root.tagName).toBe('SECTION');
    expect(root.getAttribute('class')).toBe('pulsar-template pulsar-template--terminal');
    // Scene roots mount inactive; the timeline flips them active.
    expect(root.getAttribute('data-pulsar-template-active')).toBe('false');

    const term = root.firstElementChild as HTMLElement;
    expect(term.tagName).toBe('PRE');
    expect(term.getAttribute('class')).toBe('term');
    // Nothing typed yet — playScript only runs once the timeline plays.
    expect(term.children).toHaveLength(0);
  });

  it('timeline authors the term-start label, no advance gate, and keeps the root active through the end (ADR-032)', () => {
    const ctx = makeCtx();
    const scene = terminal('term-tl', { script: [{ t: 'user', text: 'go' }], typeBaseMs: 1 });
    scene.create(ctx);
    const root = findRoot(ctx, 'term-tl');

    const tl = scene.timeline(ctx) as gsap.core.Timeline;
    expect(tl).not.toBeNull();
    expect(Object.keys(tl.labels)).toContain('term-start');
    // Run-loop holds for advance; no `_advance-gate*` master pause is authored.
    expect(Object.keys(tl.labels).filter((n) => n.startsWith('_advance'))).toEqual([]);
    expect(tl.labels['term-start']).toBe(0);
    expect(tl.duration()).toBeGreaterThan(0);

    // Before play the root is inactive; firing the leading call flips it.
    expect(root.getAttribute('data-pulsar-template-active')).toBe('false');
    tl.pause();
    tl.seek(0.001, false);
    expect(root.getAttribute('data-pulsar-template-active')).toBe('true');
    // Reaching the natural end no longer deactivates the root — the run-loop
    // holds for advance and the scene's cleanup tears down.
    complete(tl);
    expect(root.getAttribute('data-pulsar-template-active')).toBe('true');
    tl.kill();
  });

  it('user + agent steps render typed .ph-line--user / --agent lines with .ph-char spans', async () => {
    const ctx = makeCtx();
    const scene = terminal('term-typed', {
      script: [
        { t: 'user', text: 'ls' },
        { t: 'agent', text: 'ok' },
      ],
      typeBaseMs: 1,
    });
    scene.create(ctx);
    const tl = buildAndFire(scene, ctx);
    await drain(800);
    const term = findTerm(ctx, 'term-typed');

    const userLine = requireEl(term.querySelector('.ph-line--user'), 'user line');
    const agentLine = requireEl(term.querySelector('.ph-line--agent'), 'agent line');
    expect(userLine.tagName).toBe('SPAN');
    // typeNode renders each visible char as a `.ph-char` span (revealed
    // with `.show`); the line's textContent reconstitutes the source.
    expect(userLine.textContent).toBe('ls');
    expect(userLine.querySelectorAll('.ph-char')).toHaveLength(2);
    expect(
      [...userLine.querySelectorAll('.ph-char')].every((c) => c.classList.contains('show')),
    ).toBe(true);
    expect(agentLine.textContent).toBe('ok');
    expect(agentLine.querySelectorAll('.ph-char.show')).toHaveLength(2);

    tl.kill();
  });

  it('typed lines reveal [[glow]] markers as .ph-char.glow spans with markers stripped', async () => {
    const ctx = makeCtx();
    const scene = terminal('term-glow', {
      script: [{ t: 'agent', text: 'run [[boom]] now' }],
      typeBaseMs: 1,
    });
    scene.create(ctx);
    const tl = buildAndFire(scene, ctx);
    await drain(800);
    const line = requireEl(
      findTerm(ctx, 'term-glow').querySelector('.ph-line--agent'),
      'agent line',
    );

    // `[[` / `]]` markers are stripped from the rendered text.
    expect(line.textContent).toBe('run boom now');
    // Exactly the four chars inside the marker glow.
    const glow = line.querySelectorAll('.ph-char.glow');
    expect(glow).toHaveLength(4);
    expect([...glow].map((c) => c.textContent).join('')).toBe('boom');
    // Chars outside the marker are plain `.ph-char` (no glow).
    expect(line.querySelectorAll('.ph-char:not(.glow)').length).toBe('run  now'.length);
  });

  it('tool step with name + args renders .ph-tool-name and .ph-tool-args inside parens', async () => {
    const ctx = makeCtx();
    const scene = terminal('term-tool-na', {
      script: [{ t: 'tool', name: 'fetch', args: 'https://x' }],
      typeBaseMs: 1,
    });
    scene.create(ctx);
    const tl = buildAndFire(scene, ctx);
    await drain(800);
    const line = requireEl(
      findTerm(ctx, 'term-tool-na').querySelector('.ph-line--tool'),
      'tool line',
    );

    expect(line.getAttribute('class')).toBe('ph-line ph-line--tool');
    expect(requireEl(line.querySelector('.ph-tool-name'), 'tool name').textContent).toBe('fetch');
    expect(requireEl(line.querySelector('.ph-tool-args'), 'tool args').textContent).toBe(
      'https://x',
    );
    // The line reads `fetch(https://x)` — name + parens wrap the args.
    expect(line.textContent).toBe('fetch(https://x)');

    tl.kill();
  });

  it('tool step with name but no args renders empty parens (name())', async () => {
    const ctx = makeCtx();
    const scene = terminal('term-tool-n', {
      script: [{ t: 'tool', name: 'noop' }],
      typeBaseMs: 1,
    });
    scene.create(ctx);
    const tl = buildAndFire(scene, ctx);
    await drain(800);
    const line = requireEl(
      findTerm(ctx, 'term-tool-n').querySelector('.ph-line--tool'),
      'tool line',
    );

    expect(requireEl(line.querySelector('.ph-tool-name'), 'tool name').textContent).toBe('noop');
    expect(line.querySelector('.ph-tool-args')).toBeNull();
    expect(line.textContent).toBe('noop()');

    tl.kill();
  });

  it('tool step with raw text renders the text directly (no name/args spans)', async () => {
    const ctx = makeCtx();
    const scene = terminal('term-tool-t', {
      script: [{ t: 'tool', text: '$ curl example.com' }],
      typeBaseMs: 1,
    });
    scene.create(ctx);
    const tl = buildAndFire(scene, ctx);
    await drain(800);
    const line = requireEl(
      findTerm(ctx, 'term-tool-t').querySelector('.ph-line--tool'),
      'tool line',
    );

    expect(line.textContent).toBe('$ curl example.com');
    expect(line.querySelector('.ph-tool-name')).toBeNull();
    expect(line.querySelector('.ph-tool-args')).toBeNull();

    tl.kill();
  });

  it('output step with text renders an .ph-line--output line via markedTextHtml ([[glow]] → .glow)', async () => {
    const ctx = makeCtx();
    const scene = terminal('term-out-t', {
      script: [{ t: 'output', text: 'status: [[OK]] done' }],
      typeBaseMs: 1,
    });
    scene.create(ctx);
    const tl = buildAndFire(scene, ctx);
    await drain(800);
    const line = requireEl(
      findTerm(ctx, 'term-out-t').querySelector('.ph-line--output'),
      'output line',
    );

    expect(line.getAttribute('class')).toBe('ph-line ph-line--output');
    // markedTextHtml emits a `.glow` span for the marker, plain text otherwise.
    const glow = requireEl(line.querySelector('.glow'), 'output glow span');
    expect(glow.textContent).toBe('OK');
    expect(line.textContent).toBe('status: OK done');

    tl.kill();
  });

  it('output step with lines[] joins them with newlines into one output line', async () => {
    const ctx = makeCtx();
    const scene = terminal('term-out-l', {
      script: [{ t: 'output', lines: ['alpha', 'beta', 'gamma'] }],
      typeBaseMs: 1,
    });
    scene.create(ctx);
    const tl = buildAndFire(scene, ctx);
    await drain(800);
    const line = requireEl(
      findTerm(ctx, 'term-out-l').querySelector('.ph-line--output'),
      'output line',
    );

    expect(line.textContent).toBe('alpha\nbeta\ngamma');

    tl.kill();
  });

  it('output step escapes HTML so authored text is not parsed as markup', async () => {
    const ctx = makeCtx();
    const scene = terminal('term-out-esc', {
      script: [{ t: 'output', text: 'danger <img src=x> "end"' }],
      typeBaseMs: 1,
    });
    scene.create(ctx);
    const tl = buildAndFire(scene, ctx);
    await drain(800);
    const line = requireEl(
      findTerm(ctx, 'term-out-esc').querySelector('.ph-line--output'),
      'output line',
    );

    // No injected element — the angle brackets are escaped text.
    expect(line.querySelector('img')).toBeNull();
    expect(line.children).toHaveLength(0);
    expect(line.textContent).toBe('danger <img src=x> "end"');

    tl.kill();
  });

  it('popout step mounts a centered .ph-popout punch on document.body and self-removes after dwell', async () => {
    const ctx = makeCtx();
    const scene = terminal('term-popout', {
      script: [{ t: 'popout', text: 'COMPROMISED' }],
      typeBaseMs: 1,
    });
    scene.create(ctx);
    const tl = buildAndFire(scene, ctx);
    // Let the call + synchronous popout mount run.
    await drain(10);

    const popout = requireEl(document.body.querySelector('.ph-popout'), 'popout wrapper');
    expect(requireEl(popout.querySelector('.ph-popout__text'), 'popout text').textContent).toBe(
      'COMPROMISED',
    );
    // Survives its own aSleep(900) dwell.
    await drain(900);
    expect(document.body.querySelector('.ph-popout')).not.toBeNull();
    // schedule()'d removal lands at 2600ms.
    await drain(2000);
    expect(document.body.querySelector('.ph-popout')).toBeNull();

    tl.kill();
  });

  it('popout with stopClock freezes the elapsed clock (clock element survives, ticker stops)', async () => {
    const ctx = makeCtx();
    const scene = terminal('term-popout-stop', {
      script: [{ t: 'popout', text: 'HALT', stopClock: true }],
      clock: 'on-mount',
      typeBaseMs: 1,
    });
    scene.create(ctx);
    const tl = buildAndFire(scene, ctx);
    await drain(10);

    // Clock mounted on body; freeze keeps the element but stops ticking.
    const clock = requireEl(document.body.querySelector('.ph-clock'), 'clock');
    const secEl = requireEl(clock.querySelector('.ph-clock__sec'), 'clock seconds');
    const frozen = secEl.textContent;
    await drain(1500);
    // A live clock would have advanced its 250ms ticker; frozen does not.
    expect(secEl.textContent).toBe(frozen);

    tl.kill();
  });

  it('wait_counter with fastForward shows the live counter line + mounts the FF overlay, then tears it down', async () => {
    const ctx = makeCtx();
    const scene = terminal('term-wc', {
      script: [{ t: 'wait_counter', ms: 120000, label: 'scanning', fastForward: true, ffMs: 200 }],
      typeBaseMs: 1,
    });
    scene.create(ctx);
    const root = findRoot(ctx, 'term-wc');
    const term = findTerm(ctx, 'term-wc');
    const tl = buildAndFire(scene, ctx);
    await drain(10);

    // FF overlay is body-mounted; root carries the ff-active class.
    expect(root.classList.contains('ff-active')).toBe(true);
    expect(requireEl(document.body.querySelector('.ff-symbol'), 'ff symbol').textContent).toBe(
      '▶▶',
    );
    expect(document.body.querySelector('.ff-tracking')).not.toBeNull();
    // The live counter renders into an output line: `(<elapsed> · label)`.
    const counter = requireEl(term.querySelector('.ph-line--output'), 'counter line');
    expect(counter.textContent).toMatch(/^\(\d+s · scanning\)$/);

    // Drive the FF duration (200ms) to completion: overlay + line removed,
    // ff-active stripped.
    await drain(400);
    expect(root.classList.contains('ff-active')).toBe(false);
    expect(document.body.querySelector('.ff-symbol')).toBeNull();
    expect(document.body.querySelector('.ff-tracking')).toBeNull();
    expect(term.querySelector('.ph-line--output')).toBeNull();

    tl.kill();
  });

  it('wait_counter without label or fast-forward renders the bare elapsed counter and removes it', async () => {
    const ctx = makeCtx();
    const scene = terminal('term-wc-bare', {
      script: [{ t: 'wait_counter', ms: 1000 }],
      typeBaseMs: 1,
    });
    scene.create(ctx);
    const root = findRoot(ctx, 'term-wc-bare');
    const term = findTerm(ctx, 'term-wc-bare');
    const tl = buildAndFire(scene, ctx);
    await drain(10);

    // No fast-forward => no FF overlay, no ff-active class.
    expect(root.classList.contains('ff-active')).toBe(false);
    expect(document.body.querySelector('.ff-symbol')).toBeNull();
    const counter = requireEl(term.querySelector('.ph-line--output'), 'counter line');
    // Bare form (no label) is `(<elapsed>)`.
    expect(counter.textContent).toMatch(/^\(\d+s\)$/);

    // 250ms tick interval; 1000ms total => line removed once it finishes.
    await drain(1500);
    expect(term.querySelector('.ph-line--output')).toBeNull();

    tl.kill();
  });

  it('wait step dwells without adding any line, then later steps still render', async () => {
    const ctx = makeCtx();
    const scene = terminal('term-wait', {
      script: [
        { t: 'user', text: 'a' },
        { t: 'wait', ms: 500 },
        { t: 'agent', text: 'b' },
      ],
      typeBaseMs: 1,
    });
    scene.create(ctx);
    const tl = buildAndFire(scene, ctx);
    await drain(800);
    const term = findTerm(ctx, 'term-wait');

    // wait produced no line of its own; the two typed lines bracket it.
    expect(term.querySelector('.ph-line--user')?.textContent).toBe('a');
    expect(term.querySelector('.ph-line--agent')?.textContent).toBe('b');
    expect(term.querySelectorAll('.ph-line')).toHaveLength(2);

    tl.kill();
  });

  it('clock: on-mount mounts a live .ph-clock overlay on document.body that ticks', async () => {
    const ctx = makeCtx();
    const scene = terminal('term-clock', {
      script: [{ t: 'wait', ms: 5000 }],
      clock: 'on-mount',
      typeBaseMs: 1,
    });
    scene.create(ctx);
    const tl = buildAndFire(scene, ctx);
    await drain(10);

    const clock = requireEl(document.body.querySelector('.ph-clock'), 'clock');
    expect(requireEl(clock.querySelector('.ph-clock__label'), 'clock label').textContent).toBe(
      'Elapsed',
    );
    expect(clock.querySelector('.ph-clock__min')?.textContent).toBe('00');
    expect(clock.querySelector('.ph-clock__sec')?.textContent).toBe('00');

    tl.kill();
  });

  it('clock defaults to off — no .ph-clock is mounted when clock is omitted', async () => {
    const ctx = makeCtx();
    const scene = terminal('term-noclock', {
      script: [{ t: 'user', text: 'x' }],
      typeBaseMs: 1,
    });
    scene.create(ctx);
    const tl = buildAndFire(scene, ctx);
    await drain(2000);
    expect(document.body.querySelector('.ph-clock')).toBeNull();
    tl.kill();
  });

  it('srcMark mounts a .src-mark attribution overlay on document.body with the authored text', async () => {
    const ctx = makeCtx();
    const scene = terminal('term-src', {
      script: [{ t: 'user', text: 'x' }],
      srcMark: 'source: incident-2026-05',
      typeBaseMs: 1,
    });
    scene.create(ctx);
    const tl = buildAndFire(scene, ctx);
    await drain(2000);

    const mark = requireEl(document.body.querySelector('.src-mark'), 'src-mark');
    expect(mark.textContent).toBe('source: incident-2026-05');

    tl.kill();
  });

  it('reaching the timeline end keeps body-mounted clock + srcMark up; cleanup strips them (ADR-032)', async () => {
    const ctx = makeCtx();
    const scene = terminal('term-deact', {
      script: [{ t: 'user', text: 'x' }],
      clock: 'on-mount',
      srcMark: 'cite',
      typeBaseMs: 1,
    });
    scene.create(ctx);
    const root = findRoot(ctx, 'term-deact');
    const tl = buildAndFire(scene, ctx);
    await drain(2000);

    // Chrome is up + the root active while the segment plays.
    expect(document.body.querySelector('.ph-clock')).not.toBeNull();
    expect(document.body.querySelector('.src-mark')).not.toBeNull();
    expect(root.getAttribute('data-pulsar-template-active')).toBe('true');

    // Reaching the natural end no longer tears anything down — the run-loop
    // holds for advance, so the root stays active and chrome stays mounted.
    complete(tl);
    await drain(10);
    expect(root.getAttribute('data-pulsar-template-active')).toBe('true');
    expect(document.body.querySelector('.ph-clock')).not.toBeNull();
    expect(document.body.querySelector('.src-mark')).not.toBeNull();
    tl.kill();

    // The run-loop calls cleanup on scene exit; that is what strips chrome.
    scene.cleanup(ctx);
    expect(document.body.querySelector('.ph-clock')).toBeNull();
    expect(document.body.querySelector('.src-mark')).toBeNull();
  });

  it('cleanup removes the scene root AND tears down body-mounted chrome (clock + srcMark)', async () => {
    const ctx = makeCtx();
    const scene = terminal('term-cleanup', {
      script: [{ t: 'user', text: 'x' }],
      clock: 'on-mount',
      srcMark: 'cite',
      typeBaseMs: 1,
    });
    scene.create(ctx);
    const tl = buildAndFire(scene, ctx);
    await drain(2000);

    expect(ctx.stage.querySelector('[data-pulsar-template="term-cleanup"]')).not.toBeNull();
    expect(document.body.querySelector('.ph-clock')).not.toBeNull();
    expect(document.body.querySelector('.src-mark')).not.toBeNull();

    scene.cleanup(ctx);

    expect(ctx.stage.querySelector('[data-pulsar-template="term-cleanup"]')).toBeNull();
    expect(document.body.querySelector('.ph-clock')).toBeNull();
    expect(document.body.querySelector('.src-mark')).toBeNull();

    tl.kill();
  });

  it('a full mixed script renders one line per renderable step in authored order', async () => {
    const ctx = makeCtx();
    const scene = terminal('term-mixed', {
      script: [
        { t: 'user', text: 'whoami' },
        { t: 'tool', name: 'lookup', args: 'id=7' },
        { t: 'output', text: 'role: admin' },
        { t: 'wait', ms: 100 },
        { t: 'agent', text: 'done' },
      ],
      typeBaseMs: 1,
    });
    scene.create(ctx);
    const tl = buildAndFire(scene, ctx);
    // Sequential dwells: typing + aSleep(360) tool + aSleep(400) output +
    // wait(100) + agent typing — well under 2s but over 800ms.
    await drain(2000);
    const term = findTerm(ctx, 'term-mixed');

    const lines = [...term.querySelectorAll('.ph-line')];
    // wait contributes no line; the four renderable steps each do, in order.
    expect(lines.map((l) => l.className)).toEqual([
      'ph-line ph-line--user',
      'ph-line ph-line--tool',
      'ph-line ph-line--output',
      'ph-line ph-line--agent',
    ]);
    expect(lines[0]?.textContent).toBe('whoami');
    expect(lines[1]?.textContent).toBe('lookup(id=7)');
    expect(lines[2]?.textContent).toBe('role: admin');
    expect(lines[3]?.textContent).toBe('done');

    tl.kill();
  });

  it('off-DOM ctx (stage: null) is a no-op: no root, null timeline, cleanup does not throw', () => {
    const offCtx = { stage: null, mode: 'present' as const, gsap };
    const scene = terminal('term-offdom', { script: [{ t: 'user', text: 'x' }] });
    scene.create(offCtx);
    expect(scene.timeline(offCtx)).toBeNull();
    expect(() => scene.cleanup(offCtx)).not.toThrow();
  });

  it('factory derives captions from renderable steps (user/agent/tool/output), skipping wait/popout', () => {
    const scene = terminal('term-caps', {
      script: [
        { t: 'user', text: 'ls' },
        { t: 'agent', text: 'ok' },
        { t: 'tool', name: 'fetch', args: 'url' },
        { t: 'tool', text: 'raw cmd' },
        { t: 'output', lines: ['x', 'y'] },
        { t: 'wait', ms: 1 },
        { t: 'wait_counter', ms: 1 },
        { t: 'popout', text: 'NOPE' },
      ],
    });
    expect(scene.captions?.map((c) => c.text)).toEqual([
      'ls',
      'ok',
      'fetch(url)',
      'raw cmd',
      'x\ny',
    ]);
    // Captions are anchored to per-step term-<index> labels.
    expect(scene.captions?.map((c) => c.at)).toEqual([
      'term-0',
      'term-1',
      'term-2',
      'term-3',
      'term-4',
    ]);
  });
});
