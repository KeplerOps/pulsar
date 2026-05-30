// Pulsar reference deck — scene content.
//
// Audience: a presentation author who has never seen Pulsar. The deck
// answers what Pulsar is, what its abstractions are, and what URL modes
// the runtime ships, while running on the runtime so the answers are
// visible by demonstration. Every scene declares its own captions so
// `?mode=prompter` produces a real speaker view, and every scene
// declares named timeline beats so `?mode=scrub` can jump between them.

import type { SceneModule } from '../../runtime/scene';
import {
  buildTemplateScene,
  buildTemplateTimeline,
  cleanupTemplateRoot,
  mountTemplateRoot,
} from '../../system/templates/_shared';

type SurfaceKind = 'ink' | 'paper';

interface BeatTimeline {
  addLabel(name: string, time?: number): unknown;
  fromTo(target: unknown, from: object, to: object, position?: number | string): unknown;
  to(target: unknown, vars: object, position?: number | string): unknown;
  set(target: unknown, vars: object, position?: number | string): unknown;
  call(fn: () => void, params?: unknown[], position?: number | string): unknown;
}

interface SceneSpec {
  readonly id: string;
  readonly title: string;
  readonly caption: string;
  readonly surface: SurfaceKind;
  readonly section?: string;
  readonly build: (root: HTMLElement, ownerDoc: Document) => void;
  readonly beats: (tl: BeatTimeline, rootValue: string) => void;
  /**
   * When true, the L2 envelope's trailing tween is extended to an
   * effectively-indefinite duration. The composition master never
   * reaches its natural end, so the resolver does not tear scenes
   * down — reverse-navigation (`skip-backward`) keeps working from
   * the end-of-deck state. Used only by the final scene of the
   * composition.
   */
  readonly holdForever?: boolean;
}

// Build a Pulsar-deck scene. Mounts a scene root that carries the
// runtime's activation envelope plus the `.pulsar-intro` and surface
// classes the deck CSS keys on. The build callback authors the scene
// DOM; the beats callback authors the GSAP timeline within the
// runtime's standard activate-then-deactivate envelope.
const buildScene = (spec: SceneSpec): SceneModule =>
  buildTemplateScene({
    id: spec.id,
    title: spec.title,
    captions: [{ at: 'in', text: spec.caption }],
    tags: ['pulsar-intro'],
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: spec.id,
        templateKind: spec.id,
        extraClasses: ['pulsar-intro', `pi-surface--${spec.surface}`],
        buildChildren: (root, ownerDoc) => {
          spec.build(root as unknown as HTMLElement, ownerDoc as unknown as Document);
          appendFolio(root as unknown as HTMLElement, ownerDoc as unknown as Document, spec);
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: spec.id,
        // 1 hour effectively means "until the user navigates away".
        // The runtime's natural-end teardown is the only thing that
        // prevents `skip-backward` from working past the last scene;
        // an indefinite trailing tween keeps the master alive.
        suffixDurationSeconds: spec.holdForever === true ? 3600 : 0.8,
        buildSegments: (tl) => {
          spec.beats(tl as unknown as BeatTimeline, spec.id);
        },
      }),
    cleanup: cleanupTemplateRoot(spec.id),
  });

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

// Render a sequence of display tokens as a string of inline-block
// spans joined by literal text-node spaces. Inline-block elements
// collapse leading/trailing whitespace inside their own textContent,
// so the spaces have to live in text nodes between the spans.
const renderDisplayWords = (words: readonly { text: string; em?: boolean }[]): string =>
  words
    .map((w) => {
      const cls = w.em === true ? 'pi-display__w pi-display__em' : 'pi-display__w';
      return `<span class="${cls}">${escapeHtml(w.text)}</span>`;
    })
    .join('');

const appendFolio = (root: HTMLElement, doc: Document, spec: SceneSpec): void => {
  const folio = doc.createElement('div');
  folio.className = 'pi-folio';
  const mark = doc.createElement('span');
  mark.className = 'pi-folio__mark';
  mark.textContent = 'PULSAR';
  const section = doc.createElement('span');
  section.textContent = spec.section ?? spec.id;
  folio.appendChild(mark);
  folio.appendChild(section);
  root.appendChild(folio);
};

const sel = (sceneId: string, cls: string): string => `[data-pulsar-template="${sceneId}"] ${cls}`;

// ----------------------------------------------------------------------
// Scene 01 — Title
// ----------------------------------------------------------------------

const titleScene = buildScene({
  id: 'pi-title',
  title: 'Pulsar — title',
  caption: 'Pulsar. A scene-and-composition runtime.',
  surface: 'ink',
  section: '01',
  build: (root, doc) => {
    const frame = doc.createElement('div');
    frame.className = 'pi-frame pi-frame--center';

    const h1 = doc.createElement('h1');
    h1.className = 'pi-title';
    const word = 'Pulsar';
    for (const ch of word) {
      const span = doc.createElement('span');
      span.className = 'pi-title__a';
      span.textContent = ch;
      h1.appendChild(span);
    }
    const dot = doc.createElement('span');
    dot.className = 'pi-title__dot';
    dot.textContent = '.';
    h1.appendChild(dot);

    const sub = doc.createElement('p');
    sub.className = 'pi-subtitle';
    sub.textContent = 'A scene-and-composition runtime for browser presentations.';

    frame.appendChild(h1);
    frame.appendChild(sub);
    root.appendChild(frame);
  },
  beats: (tl, id) => {
    tl.addLabel('title-in', 0);
    tl.fromTo(
      sel(id, '.pi-title__a'),
      { opacity: 0, y: 22 },
      { opacity: 1, y: 0, duration: 0.6, stagger: 0.035, ease: 'expo.out' },
      0,
    );
    tl.fromTo(
      sel(id, '.pi-title__dot'),
      { opacity: 0, y: 22 },
      { opacity: 1, y: 0, duration: 0.6, ease: 'expo.out' },
      0.32,
    );
    tl.addLabel('subtitle-in', 0.9);
    tl.fromTo(
      sel(id, '.pi-subtitle'),
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, duration: 0.5, ease: 'expo.out' },
      0.9,
    );
    tl.to({}, { duration: 1.2 });
  },
});

// ----------------------------------------------------------------------
// Scene 02 — Thesis
// ----------------------------------------------------------------------

const thesisScene = buildScene({
  id: 'pi-thesis',
  title: 'Pulsar — thesis',
  caption: 'A presentation is a composition of scenes.',
  surface: 'paper',
  section: '02',
  build: (root, doc) => {
    const frame = doc.createElement('div');
    frame.className = 'pi-frame pi-frame--center';

    const display = doc.createElement('h2');
    display.className = 'pi-display';
    display.innerHTML = renderDisplayWords([
      { text: 'A' },
      { text: 'presentation' },
      { text: 'is' },
      { text: 'a' },
      { text: 'composition', em: true },
      { text: 'of' },
      { text: 'scenes.', em: true },
    ]);
    frame.appendChild(display);
    root.appendChild(frame);
  },
  beats: (tl, id) => {
    tl.addLabel('display-in', 0);
    tl.fromTo(
      sel(id, '.pi-display__w'),
      { opacity: 0, y: 18 },
      { opacity: 1, y: 0, duration: 0.7, stagger: 0.06, ease: 'expo.out' },
      0,
    );
    tl.to({}, { duration: 2.0 });
  },
});

// ----------------------------------------------------------------------
// Scene 03 — Scene definition
// ----------------------------------------------------------------------

const sceneScene = buildScene({
  id: 'pi-scene',
  title: 'Pulsar — scene',
  caption: 'A scene is a module with an id, a timeline, assets, captions, and a cleanup function.',
  surface: 'ink',
  section: '03',
  build: (root, doc) => {
    const frame = doc.createElement('div');
    frame.className = 'pi-frame';

    const eyebrow = doc.createElement('div');
    eyebrow.className = 'pi-eyebrow';
    eyebrow.textContent = 'Abstraction · 1 of 2';

    const heading = doc.createElement('h2');
    heading.className = 'pi-heading';
    heading.textContent = 'Scene';

    const body = doc.createElement('p');
    body.className = 'pi-body';
    body.textContent =
      'A module with an id, a timeline, assets, captions, and a cleanup function. Scenes do not know about each other and they do not parse URL state.';

    const code = doc.createElement('pre');
    code.className = 'pi-code';
    code.innerHTML = [
      '<span class="pi-code__k">interface</span> SceneModule {',
      '  id:          string',
      '  title:       string',
      '  duration:    number | null',
      '  assets:      readonly string[]',
      '  captions:    readonly Caption[]',
      '  audio:       readonly string[]',
      '  create:      (ctx) =&gt; void',
      '  timeline:    (ctx) =&gt; GsapTimeline | null',
      '  cleanup:     (ctx) =&gt; void',
      '}',
    ].join('\n');

    frame.appendChild(eyebrow);
    frame.appendChild(heading);
    frame.appendChild(body);
    frame.appendChild(code);
    root.appendChild(frame);
  },
  beats: (tl, id) => {
    tl.addLabel('eyebrow-in', 0);
    tl.fromTo(
      sel(id, '.pi-eyebrow'),
      { opacity: 0, y: 6 },
      { opacity: 1, y: 0, duration: 0.4, ease: 'expo.out' },
      0,
    );
    tl.addLabel('heading-in', 0.25);
    tl.fromTo(
      sel(id, '.pi-heading'),
      { opacity: 0, y: 12 },
      { opacity: 1, y: 0, duration: 0.5, ease: 'expo.out' },
      0.25,
    );
    tl.addLabel('body-in', 0.6);
    tl.fromTo(
      sel(id, '.pi-body'),
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, duration: 0.5, ease: 'expo.out' },
      0.6,
    );
    tl.addLabel('shape-in', 1.0);
    tl.fromTo(
      sel(id, '.pi-code'),
      { opacity: 0, y: 12 },
      { opacity: 1, y: 0, duration: 0.6, ease: 'expo.out' },
      1.0,
    );
    tl.to({}, { duration: 1.6 });
  },
});

// ----------------------------------------------------------------------
// Scene 04 — Composition definition
// ----------------------------------------------------------------------

const compositionScene = buildScene({
  id: 'pi-composition',
  title: 'Pulsar — composition',
  caption:
    'A composition is an ordered list of scene ids with transitions. The manifest is data, not control flow.',
  surface: 'ink',
  section: '04',
  build: (root, doc) => {
    const frame = doc.createElement('div');
    frame.className = 'pi-frame';

    const eyebrow = doc.createElement('div');
    eyebrow.className = 'pi-eyebrow';
    eyebrow.textContent = 'Abstraction · 2 of 2';

    const heading = doc.createElement('h2');
    heading.className = 'pi-heading';
    heading.textContent = 'Composition';

    const body = doc.createElement('p');
    body.className = 'pi-body';
    body.textContent =
      'An ordered list of scene ids with transitions. The manifest is data, not control flow. Sequencing belongs to the composition layer; scenes contain no successor knowledge.';

    const code = doc.createElement('pre');
    code.className = 'pi-code';
    code.innerHTML = [
      '<span class="pi-code__k">const</span> manifest: CompositionManifest = [',
      '  <span class="pi-code__c">// bare scene id</span>',
      "  'opening',",
      '  <span class="pi-code__c">// per-entry override: transition declared by the composition</span>',
      "  { id: 'walkthrough', behavior: { transition: { name: 'dissolve' } } },",
      "  { id: 'demo',        behavior: { transition: { name: 'hold-on-black' } } },",
      "  { id: 'closing' },",
      ']',
    ].join('\n');

    frame.appendChild(eyebrow);
    frame.appendChild(heading);
    frame.appendChild(body);
    frame.appendChild(code);
    root.appendChild(frame);
  },
  beats: (tl, id) => {
    tl.addLabel('eyebrow-in', 0);
    tl.fromTo(
      sel(id, '.pi-eyebrow'),
      { opacity: 0, y: 6 },
      { opacity: 1, y: 0, duration: 0.4, ease: 'expo.out' },
      0,
    );
    tl.addLabel('heading-in', 0.25);
    tl.fromTo(
      sel(id, '.pi-heading'),
      { opacity: 0, y: 12 },
      { opacity: 1, y: 0, duration: 0.5, ease: 'expo.out' },
      0.25,
    );
    tl.addLabel('body-in', 0.6);
    tl.fromTo(
      sel(id, '.pi-body'),
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, duration: 0.5, ease: 'expo.out' },
      0.6,
    );
    tl.addLabel('shape-in', 1.0);
    tl.fromTo(
      sel(id, '.pi-code'),
      { opacity: 0, y: 12 },
      { opacity: 1, y: 0, duration: 0.6, ease: 'expo.out' },
      1.0,
    );
    tl.to({}, { duration: 1.6 });
  },
});

// ----------------------------------------------------------------------
// Scene 05 — Recomposition
// ----------------------------------------------------------------------

const recomposeScene = buildScene({
  id: 'pi-recompose',
  title: 'Pulsar — recomposition',
  caption: 'The same scene modules can be sequenced into different compositions.',
  surface: 'paper',
  section: '05',
  build: (root, doc) => {
    const frame = doc.createElement('div');
    frame.className = 'pi-frame';

    const eyebrow = doc.createElement('div');
    eyebrow.className = 'pi-eyebrow';
    eyebrow.textContent = 'Recomposition';

    const heading = doc.createElement('h2');
    heading.className = 'pi-heading';
    heading.textContent = 'Same scenes. Different compositions.';

    const body = doc.createElement('p');
    body.className = 'pi-body';
    body.textContent =
      'Scenes are owned by no single composition. A library of scenes can be sequenced into a full talk, a short cut for a meetup, or a looping kiosk reel without forking.';

    const tri = doc.createElement('div');
    tri.className = 'pi-tri';

    const shared = new Set(['opener', 'thesis', 'recompose']);
    const columns: readonly { name: string; scenes: readonly string[] }[] = [
      {
        name: 'Full talk',
        scenes: [
          'opener',
          'thesis',
          'scene',
          'composition',
          'recompose',
          'modes',
          'transport',
          'layers',
          'author',
          'self',
          'outro',
        ],
      },
      {
        name: 'Five-minute cut',
        scenes: ['opener', 'thesis', 'recompose', 'modes', 'outro'],
      },
      {
        name: 'Lobby loop',
        scenes: ['opener', 'thesis', 'recompose'],
      },
    ];

    for (const col of columns) {
      const colEl = doc.createElement('div');
      colEl.className = 'pi-tri__col';

      const name = doc.createElement('p');
      name.className = 'pi-tri__name';
      name.textContent = col.name;

      const rule = doc.createElement('div');
      rule.className = 'pi-tri__rule';

      const list = doc.createElement('ol');
      list.className = 'pi-tri__list';
      col.scenes.forEach((scene, idx) => {
        const li = doc.createElement('li');
        li.className = shared.has(scene) ? 'pi-tri__item pi-tri__item--shared' : 'pi-tri__item';
        const num = doc.createElement('span');
        num.className = 'pi-tri__num';
        num.textContent = String(idx + 1).padStart(2, '0');
        const sceneId = doc.createElement('span');
        sceneId.className = 'pi-tri__id';
        sceneId.textContent = scene;
        li.appendChild(num);
        li.appendChild(sceneId);
        list.appendChild(li);
      });

      colEl.appendChild(name);
      colEl.appendChild(rule);
      colEl.appendChild(list);
      tri.appendChild(colEl);
    }

    frame.appendChild(eyebrow);
    frame.appendChild(heading);
    frame.appendChild(body);
    frame.appendChild(tri);
    root.appendChild(frame);
  },
  beats: (tl, id) => {
    tl.addLabel('eyebrow-in', 0);
    tl.fromTo(
      sel(id, '.pi-eyebrow'),
      { opacity: 0, y: 6 },
      { opacity: 1, y: 0, duration: 0.4, ease: 'expo.out' },
      0,
    );
    tl.addLabel('heading-in', 0.25);
    tl.fromTo(
      sel(id, '.pi-heading'),
      { opacity: 0, y: 12 },
      { opacity: 1, y: 0, duration: 0.5, ease: 'expo.out' },
      0.25,
    );
    tl.addLabel('body-in', 0.6);
    tl.fromTo(
      sel(id, '.pi-body'),
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, duration: 0.5, ease: 'expo.out' },
      0.6,
    );
    tl.addLabel('cols-in', 1.0);
    tl.fromTo(
      sel(id, '.pi-tri__col'),
      { opacity: 0, y: 18 },
      { opacity: 1, y: 0, duration: 0.7, stagger: 0.18, ease: 'expo.out' },
      1.0,
    );
    tl.to({}, { duration: 1.6 });
  },
});

// ----------------------------------------------------------------------
// Scene 06 — Modes
// ----------------------------------------------------------------------

const modesScene = buildScene({
  id: 'pi-modes',
  title: 'Pulsar — modes',
  caption: 'The same composition runs in many modes. Mode is read from the URL.',
  surface: 'ink',
  section: '06',
  build: (root, doc) => {
    const frame = doc.createElement('div');
    frame.className = 'pi-frame';

    const eyebrow = doc.createElement('div');
    eyebrow.className = 'pi-eyebrow';
    eyebrow.textContent = 'Modes';

    const heading = doc.createElement('h2');
    heading.className = 'pi-heading';
    heading.textContent = 'One composition, many modes.';

    const grid = doc.createElement('div');
    grid.className = 'pi-modes';

    const rows: readonly { url: string; desc: string }[] = [
      {
        url: '?mode=present',
        desc: 'Full composition. Audio unlock, presenter keys, transport gates.',
      },
      { url: '?mode=scrub', desc: 'Manual transport. Beat jumps. Reverse-safe audio gating.' },
      { url: '?mode=prompter', desc: 'Captions only. No animation. A second window can pop out.' },
      { url: '?mode=loop', desc: 'Composition repeats until aborted.' },
      { url: '?mode=paused', desc: 'Hold at frame zero. Useful for inspection.' },
      {
        url: '?mode=screenshot',
        desc: 'Deterministic frame. Seeded RNG. Silent audio. Capture-ready.',
      },
    ];
    for (const r of rows) {
      const url = doc.createElement('div');
      url.className = 'pi-modes__url';
      const eq = r.url.indexOf('=');
      url.innerHTML = `${r.url.slice(0, eq + 1)}<span class="pi-modes__k">${r.url.slice(eq + 1)}</span>`;

      const desc = doc.createElement('div');
      desc.className = 'pi-modes__desc';
      desc.textContent = r.desc;

      grid.appendChild(url);
      grid.appendChild(desc);
    }

    frame.appendChild(eyebrow);
    frame.appendChild(heading);
    frame.appendChild(grid);
    root.appendChild(frame);
  },
  beats: (tl, id) => {
    tl.addLabel('eyebrow-in', 0);
    tl.fromTo(
      sel(id, '.pi-eyebrow'),
      { opacity: 0, y: 6 },
      { opacity: 1, y: 0, duration: 0.4, ease: 'expo.out' },
      0,
    );
    tl.addLabel('heading-in', 0.25);
    tl.fromTo(
      sel(id, '.pi-heading'),
      { opacity: 0, y: 12 },
      { opacity: 1, y: 0, duration: 0.5, ease: 'expo.out' },
      0.25,
    );
    tl.addLabel('rows-in', 0.7);
    tl.fromTo(
      sel(id, '.pi-modes__url'),
      { opacity: 0, x: -8 },
      { opacity: 1, x: 0, duration: 0.4, stagger: 0.09, ease: 'expo.out' },
      0.7,
    );
    tl.fromTo(
      sel(id, '.pi-modes__desc'),
      { opacity: 0 },
      { opacity: 1, duration: 0.4, stagger: 0.09, ease: 'expo.out' },
      0.78,
    );
    tl.to({}, { duration: 1.6 });
  },
});

// ----------------------------------------------------------------------
// Scene 07 — URL rule
// ----------------------------------------------------------------------

const urlScene = buildScene({
  id: 'pi-url',
  title: 'Pulsar — URL',
  caption: 'The URL is the only source of mode.',
  surface: 'paper',
  section: '07',
  build: (root, doc) => {
    const frame = doc.createElement('div');
    frame.className = 'pi-frame pi-frame--center';

    const display = doc.createElement('h2');
    display.className = 'pi-display';
    display.innerHTML = renderDisplayWords([
      { text: 'The' },
      { text: 'URL' },
      { text: 'is' },
      { text: 'the' },
      { text: 'only' },
      { text: 'source' },
      { text: 'of' },
      { text: 'mode.', em: true },
    ]);

    const url = doc.createElement('p');
    url.className = 'pi-body';
    url.style.fontFamily = 'var(--pi-mono)';
    url.style.marginTop = 'clamp(28px, 3vh, 48px)';
    url.style.textAlign = 'center';
    url.innerHTML =
      '?composition=&lt;id&gt;<span class="pi-mark">&amp;mode=&lt;mode&gt;</span>&amp;scene=&lt;id&gt;&amp;beat=&lt;label&gt;';

    frame.appendChild(display);
    frame.appendChild(url);
    root.appendChild(frame);
  },
  beats: (tl, id) => {
    tl.addLabel('display-in', 0);
    tl.fromTo(
      sel(id, '.pi-display__w'),
      { opacity: 0, y: 16 },
      { opacity: 1, y: 0, duration: 0.6, stagger: 0.06, ease: 'expo.out' },
      0,
    );
    tl.addLabel('url-in', 0.9);
    tl.fromTo(
      sel(id, '.pi-body'),
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, duration: 0.5, ease: 'expo.out' },
      0.9,
    );
    tl.to({}, { duration: 1.6 });
  },
});

// ----------------------------------------------------------------------
// Scene 08 — Transport
// ----------------------------------------------------------------------

const transportScene = buildScene({
  id: 'pi-transport',
  title: 'Pulsar — transport',
  caption: 'Transitions, named beats, scrub, audio, prompter, presenter keys.',
  surface: 'ink',
  section: '08',
  build: (root, doc) => {
    const frame = doc.createElement('div');
    frame.className = 'pi-frame';

    const eyebrow = doc.createElement('div');
    eyebrow.className = 'pi-eyebrow';
    eyebrow.textContent = 'Transport';

    const heading = doc.createElement('h2');
    heading.className = 'pi-heading';
    heading.textContent = 'What the runtime owns.';

    const grid = doc.createElement('div');
    grid.className = 'pi-modes';

    const rows: readonly { url: string; desc: string }[] = [
      { url: 'inter-scene transitions', desc: 'cut, dissolve, hard-slam, hold-on-black, push.' },
      { url: 'named beats', desc: 'Kebab labels on each scene timeline. Addressable by URL.' },
      { url: 'audio service', desc: 'Per-navigation Howler engine with a reverse-safe cue gate.' },
      { url: 'prompter', desc: 'Captions rendered in a chrome slot or a popped-out window.' },
      { url: 'presenter keys', desc: 'Advance, reverse, skip, pause, resume, mute, home.' },
      {
        url: 'asset preloader',
        desc: 'Scenes declare assets. The loader warms them per navigation.',
      },
    ];
    for (const r of rows) {
      const url = doc.createElement('div');
      url.className = 'pi-modes__url';
      url.textContent = r.url;

      const desc = doc.createElement('div');
      desc.className = 'pi-modes__desc';
      desc.textContent = r.desc;

      grid.appendChild(url);
      grid.appendChild(desc);
    }

    frame.appendChild(eyebrow);
    frame.appendChild(heading);
    frame.appendChild(grid);
    root.appendChild(frame);
  },
  beats: (tl, id) => {
    tl.addLabel('eyebrow-in', 0);
    tl.fromTo(
      sel(id, '.pi-eyebrow'),
      { opacity: 0, y: 6 },
      { opacity: 1, y: 0, duration: 0.4, ease: 'expo.out' },
      0,
    );
    tl.addLabel('heading-in', 0.25);
    tl.fromTo(
      sel(id, '.pi-heading'),
      { opacity: 0, y: 12 },
      { opacity: 1, y: 0, duration: 0.5, ease: 'expo.out' },
      0.25,
    );
    tl.addLabel('rows-in', 0.7);
    tl.fromTo(
      sel(id, '.pi-modes__url'),
      { opacity: 0, x: -8 },
      { opacity: 1, x: 0, duration: 0.4, stagger: 0.09, ease: 'expo.out' },
      0.7,
    );
    tl.fromTo(
      sel(id, '.pi-modes__desc'),
      { opacity: 0 },
      { opacity: 1, duration: 0.4, stagger: 0.09, ease: 'expo.out' },
      0.78,
    );
    tl.to({}, { duration: 1.6 });
  },
});

// ----------------------------------------------------------------------
// Scene 09 — Layers
// ----------------------------------------------------------------------

const layersScene = buildScene({
  id: 'pi-layers',
  title: 'Pulsar — layers',
  caption: 'Three layers: engine, system, deck.',
  surface: 'paper',
  section: '09',
  build: (root, doc) => {
    const frame = doc.createElement('div');
    frame.className = 'pi-frame';

    const eyebrow = doc.createElement('div');
    eyebrow.className = 'pi-eyebrow';
    eyebrow.textContent = 'Architecture';

    const heading = doc.createElement('h2');
    heading.className = 'pi-heading';
    heading.textContent = 'Three layers.';

    const grid = doc.createElement('div');
    grid.className = 'pi-layers';

    const layers: readonly { tag: string; name: string; items: readonly string[] }[] = [
      {
        tag: 'L1',
        name: 'Engine',
        items: ['registry', 'resolver', 'loader', 'timeline', 'audio', 'validation'],
      },
      {
        tag: 'L2',
        name: 'System',
        items: ['chrome', 'transitions', 'prompter', 'presenter keys', 'scrub controls'],
      },
      {
        tag: 'L3',
        name: 'Deck',
        items: ['scene modules', 'composition manifest', 'per-deck CSS'],
      },
    ];
    for (const l of layers) {
      const layer = doc.createElement('div');
      layer.className = 'pi-layer';

      const tag = doc.createElement('div');
      tag.className = 'pi-layer__tag';
      tag.textContent = l.tag;

      const name = doc.createElement('h3');
      name.className = 'pi-layer__name';
      name.textContent = l.name;

      const list = doc.createElement('ul');
      list.className = 'pi-layer__list';
      for (const item of l.items) {
        const li = doc.createElement('li');
        li.textContent = item;
        list.appendChild(li);
      }

      layer.appendChild(tag);
      layer.appendChild(name);
      layer.appendChild(list);
      grid.appendChild(layer);
    }

    frame.appendChild(eyebrow);
    frame.appendChild(heading);
    frame.appendChild(grid);
    root.appendChild(frame);
  },
  beats: (tl, id) => {
    tl.addLabel('eyebrow-in', 0);
    tl.fromTo(
      sel(id, '.pi-eyebrow'),
      { opacity: 0, y: 6 },
      { opacity: 1, y: 0, duration: 0.4, ease: 'expo.out' },
      0,
    );
    tl.addLabel('heading-in', 0.25);
    tl.fromTo(
      sel(id, '.pi-heading'),
      { opacity: 0, y: 12 },
      { opacity: 1, y: 0, duration: 0.5, ease: 'expo.out' },
      0.25,
    );
    tl.addLabel('layers-in', 0.7);
    tl.fromTo(
      sel(id, '.pi-layer'),
      { opacity: 0, y: 18 },
      { opacity: 1, y: 0, duration: 0.6, stagger: 0.16, ease: 'expo.out' },
      0.7,
    );
    tl.to({}, { duration: 1.6 });
  },
});

// ----------------------------------------------------------------------
// Scene 10 — Authoring
// ----------------------------------------------------------------------

const authorScene = buildScene({
  id: 'pi-author',
  title: 'Pulsar — authoring',
  caption: 'A new deck is scene content plus a composition manifest. No runtime fork.',
  surface: 'ink',
  section: '10',
  build: (root, doc) => {
    const frame = doc.createElement('div');
    frame.className = 'pi-frame';

    const eyebrow = doc.createElement('div');
    eyebrow.className = 'pi-eyebrow';
    eyebrow.textContent = 'Authoring';

    const heading = doc.createElement('h2');
    heading.className = 'pi-heading';
    heading.textContent = 'A new deck is content.';

    const body = doc.createElement('p');
    body.className = 'pi-body';
    body.textContent =
      'Two files. Scene modules declare what to show. A composition manifest declares the order and transitions. The runtime is untouched.';

    const code = doc.createElement('pre');
    code.className = 'pi-code';
    code.innerHTML = [
      '<span class="pi-code__c">// src/decks/my-talk/content.ts</span>',
      '<span class="pi-code__k">export const</span> MY_TALK_SCENES = [openingScene, walkthroughScene, demoScene] <span class="pi-code__k">as const</span>',
      '',
      '<span class="pi-code__c">// src/decks/my-talk/composition.ts</span>',
      '<span class="pi-code__k">export const</span> myTalkComposition: CompositionManifest = [',
      "  'opening',",
      "  { id: 'walkthrough', behavior: { transition: { name: 'dissolve' } } },",
      "  { id: 'demo',        behavior: { transition: { name: 'hold-on-black' } } },",
      ']',
    ].join('\n');

    frame.appendChild(eyebrow);
    frame.appendChild(heading);
    frame.appendChild(body);
    frame.appendChild(code);
    root.appendChild(frame);
  },
  beats: (tl, id) => {
    tl.addLabel('eyebrow-in', 0);
    tl.fromTo(
      sel(id, '.pi-eyebrow'),
      { opacity: 0, y: 6 },
      { opacity: 1, y: 0, duration: 0.4, ease: 'expo.out' },
      0,
    );
    tl.addLabel('heading-in', 0.25);
    tl.fromTo(
      sel(id, '.pi-heading'),
      { opacity: 0, y: 12 },
      { opacity: 1, y: 0, duration: 0.5, ease: 'expo.out' },
      0.25,
    );
    tl.addLabel('body-in', 0.6);
    tl.fromTo(
      sel(id, '.pi-body'),
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, duration: 0.5, ease: 'expo.out' },
      0.6,
    );
    tl.addLabel('shape-in', 1.0);
    tl.fromTo(
      sel(id, '.pi-code'),
      { opacity: 0, y: 12 },
      { opacity: 1, y: 0, duration: 0.6, ease: 'expo.out' },
      1.0,
    );
    tl.to({}, { duration: 1.6 });
  },
});

// ----------------------------------------------------------------------
// Scene 11 — Self-reference
// ----------------------------------------------------------------------

const selfScene = buildScene({
  id: 'pi-self',
  title: 'Pulsar — self-reference',
  caption: 'You are watching one composition of these scenes.',
  surface: 'paper',
  section: '11',
  build: (root, doc) => {
    const frame = doc.createElement('div');
    frame.className = 'pi-frame pi-frame--center';

    const display = doc.createElement('h2');
    display.className = 'pi-display';
    display.innerHTML = renderDisplayWords([
      { text: 'You' },
      { text: 'are' },
      { text: 'watching' },
      { text: 'one', em: true },
      { text: 'composition' },
      { text: 'of' },
      { text: 'these' },
      { text: 'scenes.' },
    ]);

    const sub = doc.createElement('p');
    sub.className = 'pi-body';
    sub.style.fontFamily = 'var(--pi-mono)';
    sub.style.marginTop = 'clamp(24px, 3vh, 40px)';
    sub.style.textAlign = 'center';
    sub.textContent = '?composition=pulsar-intro&mode=present';

    frame.appendChild(display);
    frame.appendChild(sub);
    root.appendChild(frame);
  },
  beats: (tl, id) => {
    tl.addLabel('display-in', 0);
    tl.fromTo(
      sel(id, '.pi-display__w'),
      { opacity: 0, y: 16 },
      { opacity: 1, y: 0, duration: 0.6, stagger: 0.07, ease: 'expo.out' },
      0,
    );
    tl.addLabel('sub-in', 1.0);
    tl.fromTo(
      sel(id, '.pi-body'),
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, duration: 0.5, ease: 'expo.out' },
      1.0,
    );
    tl.to({}, { duration: 1.4 });
  },
});

// ----------------------------------------------------------------------
// Scene 12 — Outro / try it
// ----------------------------------------------------------------------

const outroScene = buildScene({
  id: 'pi-outro',
  title: 'Pulsar — try it',
  caption: 'Try these URLs on the same composition.',
  surface: 'ink',
  section: 'end · 12 of 12',
  holdForever: true,
  build: (root, doc) => {
    const frame = doc.createElement('div');
    frame.className = 'pi-frame';

    const eyebrow = doc.createElement('div');
    eyebrow.className = 'pi-eyebrow';
    eyebrow.textContent = 'Try it';

    const heading = doc.createElement('h2');
    heading.className = 'pi-heading';
    heading.textContent = 'Same composition. Paste any of these into the address bar.';

    const list = doc.createElement('div');
    list.className = 'pi-tries';

    const rows: readonly { url: string; desc: string }[] = [
      {
        url: '?composition=pulsar-intro&mode=scrub',
        desc: 'A scrub bar mounts; jump between named beats.',
      },
      {
        url: '?composition=pulsar-intro&mode=prompter',
        desc: 'Captions only. Pop a second window for the speaker view.',
      },
      {
        url: '?composition=pulsar-intro&mode=loop',
        desc: 'The composition restarts on completion.',
      },
      {
        url: '?composition=pulsar-intro&mode=paused',
        desc: 'Held at frame zero. Useful for inspection.',
      },
      {
        url: '?scene=pi-recompose&mode=present',
        desc: 'Address a single scene without surrounding composition.',
      },
    ];
    for (const r of rows) {
      const row = doc.createElement('div');
      row.className = 'pi-try';
      const url = doc.createElement('div');
      url.className = 'pi-try__url';
      url.textContent = r.url;
      const desc = doc.createElement('div');
      desc.className = 'pi-try__desc';
      desc.textContent = r.desc;
      row.appendChild(url);
      row.appendChild(desc);
      list.appendChild(row);
    }

    frame.appendChild(eyebrow);
    frame.appendChild(heading);
    frame.appendChild(list);
    root.appendChild(frame);
  },
  beats: (tl, id) => {
    tl.addLabel('eyebrow-in', 0);
    tl.fromTo(
      sel(id, '.pi-eyebrow'),
      { opacity: 0, y: 6 },
      { opacity: 1, y: 0, duration: 0.4, ease: 'expo.out' },
      0,
    );
    tl.addLabel('heading-in', 0.25);
    tl.fromTo(
      sel(id, '.pi-heading'),
      { opacity: 0, y: 12 },
      { opacity: 1, y: 0, duration: 0.5, ease: 'expo.out' },
      0.25,
    );
    tl.addLabel('rows-in', 0.7);
    tl.fromTo(
      sel(id, '.pi-try'),
      { opacity: 0, x: -8 },
      { opacity: 1, x: 0, duration: 0.45, stagger: 0.13, ease: 'expo.out' },
      0.7,
    );
    tl.to({}, { duration: 1.6 });
  },
});

export const PULSAR_INTRO_SCENES: readonly SceneModule[] = [
  titleScene,
  thesisScene,
  sceneScene,
  compositionScene,
  recomposeScene,
  modesScene,
  urlScene,
  transportScene,
  layersScene,
  authorScene,
  selfScene,
  outroScene,
];
