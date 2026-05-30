// ACES ecosystem intro deck.
//
// Audience: a research-literate reader who has not used aces-sdl. The
// deck is a structural introduction to the repository: definition,
// scope boundary, top-level layout, contract surface, conformance, and
// the documents to read next. Every claim is grounded in a file under
// `../aces-sdl/` and `../F1/`; citations
// appear inline as `[<repo-relative path>:<line range>]` and again in
// the references appendix.
//
// The deck makes no claim that ACES addresses any F1-charted instrument
// problem. The instrument papers (A1, A2, ...) are the venue for that
// argument; this is an introduction to how the SDL repository is
// structured.

import type { SceneModule } from '../../runtime/scene';
import {
  type TemplateTimeline,
  buildTemplateScene,
  buildTemplateTimeline,
  cleanupTemplateRoot,
  mountTemplateRoot,
} from '../../system/templates/_shared';

interface SceneSpec {
  readonly id: string;
  readonly title: string;
  readonly caption: string;
  readonly section: string;
  readonly cite?: string;
  readonly build: (root: HTMLElement, ownerDoc: Document) => void;
  readonly beats: (tl: TemplateTimeline, rootValue: string) => void;
  /**
   * When true, the trailing tween is extended to an
   * effectively-indefinite duration so the master never reaches its
   * natural end — `skip-backward` from the end of the deck still seeks
   * to an earlier segment instead of operating on a torn-down master.
   */
  readonly holdForever?: boolean;
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const sel = (sceneId: string, cls: string): string => `[data-pulsar-template="${sceneId}"] ${cls}`;

const buildScene = (spec: SceneSpec): SceneModule =>
  buildTemplateScene({
    id: spec.id,
    title: spec.title,
    captions: [{ at: 'in', text: spec.caption }],
    tags: ['aces-ecosystem-intro'],
    create: (ctx) => {
      mountTemplateRoot({
        ctx,
        rootValue: spec.id,
        templateKind: spec.id,
        extraClasses: ['aces-intro'],
        buildChildren: (root, ownerDoc) => {
          const d = ownerDoc;
          const page = d.createElement('div');
          page.className = 'ax-page';

          const head = d.createElement('div');
          head.className = 'ax-head';
          const mark = d.createElement('span');
          mark.className = 'ax-head__mark';
          mark.textContent = 'aces-sdl · introduction';
          const sectionLabel = d.createElement('span');
          sectionLabel.textContent = spec.section;
          head.appendChild(mark);
          head.appendChild(sectionLabel);

          const body = d.createElement('div');
          body.className = 'ax-body';
          spec.build(body, d);

          const foot = d.createElement('div');
          foot.className = 'ax-foot';
          const cite = d.createElement('span');
          cite.className = 'ax-foot__cite';
          cite.textContent = spec.cite ?? '';
          const num = d.createElement('span');
          num.className = 'ax-foot__num';
          num.textContent = spec.id;
          foot.appendChild(cite);
          foot.appendChild(num);

          page.appendChild(head);
          page.appendChild(body);
          page.appendChild(foot);
          root.appendChild(page);
        },
      });
    },
    timeline: (ctx) =>
      buildTemplateTimeline({
        ctx,
        rootValue: spec.id,
        suffixDurationSeconds: spec.holdForever === true ? 3600 : 0.6,
        buildSegments: (tl) => {
          spec.beats(tl, spec.id);
        },
      }),
    cleanup: cleanupTemplateRoot(spec.id),
  });

// Restrained motion. Body fades in at 200ms; structural rows
// stagger at 80ms; pull quotes fade up with a 12px nudge.
const fadeIn = (
  tl: TemplateTimeline,
  id: string,
  cls: string,
  at: number,
  opts: { stagger?: number; y?: number; duration?: number } = {},
): void => {
  tl.fromTo(
    sel(id, cls),
    { opacity: 0, y: opts.y ?? 6 },
    {
      opacity: 1,
      y: 0,
      duration: opts.duration ?? 0.45,
      stagger: opts.stagger ?? 0,
      ease: 'power2.out',
    },
    at,
  );
};

const cite = (path: string): string => `<span class="ax-cite">[${escapeHtml(path)}]</span>`;

// ----------------------------------------------------------------------
// Cover
// ----------------------------------------------------------------------

const coverScene = buildScene({
  id: 'aces-cover',
  title: 'ACES — cover',
  caption:
    'ACES — Agentic Cyber Environment System. Backend-agnostic scenario description language, Python reference implementation, and contract surface.',
  section: 'cover',
  build: (body, d) => {
    const cover = d.createElement('div');
    cover.className = 'ax-cover';

    const title = d.createElement('h1');
    title.className = 'ax-cover__title';
    title.textContent = 'ACES';

    const expand = d.createElement('p');
    expand.className = 'ax-cover__expand';
    expand.textContent = 'Agentic Cyber Environment System';

    const rule = d.createElement('div');
    rule.className = 'ax-cover__rule';

    const abstract = d.createElement('p');
    abstract.className = 'ax-cover__abstract';
    abstract.innerHTML =
      '&ldquo;Agentic Cyber Environment System (ACES) is a backend-agnostic scenario description language, Python reference implementation, and contract surface for cyber range scenarios and experiments.&rdquo;<cite>README.md:1&ndash;5</cite>';

    cover.appendChild(title);
    cover.appendChild(expand);
    cover.appendChild(rule);
    cover.appendChild(abstract);
    body.appendChild(cover);
  },
  beats: (tl, id) => {
    tl.addLabel('cover-in', 0);
    fadeIn(tl, id, '.ax-cover__title', 0, { y: 18, duration: 0.7 });
    fadeIn(tl, id, '.ax-cover__expand', 0.45);
    fadeIn(tl, id, '.ax-cover__rule', 0.75, { duration: 0.4 });
    fadeIn(tl, id, '.ax-cover__abstract', 0.95, { duration: 0.55 });
    tl.to({}, { duration: 1.4 });
  },
});

// ----------------------------------------------------------------------
// Non-claim
// ----------------------------------------------------------------------

const nonClaimScene = buildScene({
  id: 'aces-non-claim',
  title: 'ACES — non-claim',
  caption:
    'Motivation is not validation. This briefing introduces the structure of the aces-sdl repository.',
  section: 'front matter',
  cite: 'lit-review-plan.md · aces-instrument-paper-details.md',
  build: (body, d) => {
    const content = d.createElement('div');
    content.className = 'ax-content';

    const eyebrow = d.createElement('div');
    eyebrow.className = 'ax-eyebrow';
    eyebrow.textContent = 'Scope';

    const pull = d.createElement('blockquote');
    pull.className = 'ax-pull';
    pull.innerHTML = 'Motivation is not validation.';

    const prose = d.createElement('p');
    prose.className = 'ax-prose';
    prose.innerHTML = `F1 charts recurring methodological and instrument problems in AI cyber autonomy evaluation ${cite('F1/lit-review-plan.md:1–3')}. This briefing describes how the <em>aces-sdl</em> repository is structured. Whether ACES addresses any F1-charted problem is a question for the instrument papers (A1, A2, ...) ${cite('aces-instrument-paper-details.md')}, not this introduction.`;

    content.appendChild(eyebrow);
    content.appendChild(pull);
    content.appendChild(prose);
    body.appendChild(content);
  },
  beats: (tl, id) => {
    tl.addLabel('non-claim-in', 0);
    fadeIn(tl, id, '.ax-eyebrow', 0);
    fadeIn(tl, id, '.ax-pull', 0.2, { y: 12, duration: 0.55 });
    fadeIn(tl, id, '.ax-prose', 0.6, { duration: 0.5 });
    tl.to({}, { duration: 1.4 });
  },
});

// ----------------------------------------------------------------------
// Section map
// ----------------------------------------------------------------------

const tocScene = buildScene({
  id: 'aces-toc',
  title: 'ACES — sections',
  caption: 'Five sections: motivation, definition, structure, contracts, reading.',
  section: 'contents',
  build: (body, d) => {
    const content = d.createElement('div');
    content.className = 'ax-content';

    const eyebrow = d.createElement('div');
    eyebrow.className = 'ax-eyebrow';
    eyebrow.textContent = 'Contents';

    const heading = d.createElement('h2');
    heading.className = 'ax-heading';
    heading.textContent = 'Five sections.';

    const list = d.createElement('ol');
    list.className = 'ax-toc';
    const rows: readonly { title: string; sub: string }[] = [
      {
        title: 'Why this apparatus exists.',
        sub: 'Instrument problems in AI cyber autonomy evaluation. F1.',
      },
      {
        title: 'What the SDL is.',
        sub: 'Definition, what it separates, and what it is not.',
      },
      {
        title: 'Repository structure.',
        sub: 'Specs, contracts, implementations, examples, docs, research, tools.',
      },
      {
        title: 'Contracts and conformance.',
        sub: 'Published machine-readable surface and how it is enforced.',
      },
      {
        title: 'Reading after this talk.',
        sub: 'A traversal order for the repository.',
      },
    ];
    rows.forEach((r, i) => {
      const row = d.createElement('li');
      row.className = 'ax-toc__row';
      const num = d.createElement('span');
      num.className = 'ax-toc__num';
      num.textContent = `§${i + 1}`;
      const text = d.createElement('span');
      text.className = 'ax-toc__text';
      text.innerHTML = `${escapeHtml(r.title)}<small>${escapeHtml(r.sub)}</small>`;
      row.appendChild(num);
      row.appendChild(text);
      list.appendChild(row);
    });

    content.appendChild(eyebrow);
    content.appendChild(heading);
    content.appendChild(list);
    body.appendChild(content);
  },
  beats: (tl, id) => {
    tl.addLabel('toc-in', 0);
    fadeIn(tl, id, '.ax-eyebrow', 0);
    fadeIn(tl, id, '.ax-heading', 0.18, { y: 10, duration: 0.5 });
    fadeIn(tl, id, '.ax-toc__num', 0.55, { stagger: 0.08, y: 8 });
    fadeIn(tl, id, '.ax-toc__text', 0.6, { stagger: 0.08, y: 8 });
    tl.to({}, { duration: 1.6 });
  },
});

// ----------------------------------------------------------------------
// §1 — Section title
// ----------------------------------------------------------------------

const section1 = buildScene({
  id: 'aces-1',
  title: 'ACES — §1 title',
  caption: 'Section one. Why this apparatus exists.',
  section: '§1',
  build: (body, d) => {
    const sec = d.createElement('div');
    sec.className = 'ax-section';
    const num = d.createElement('div');
    num.className = 'ax-section__num';
    num.textContent = 'Section 1';
    const title = d.createElement('h2');
    title.className = 'ax-section__title';
    title.textContent = 'Why this apparatus exists.';
    const lede = d.createElement('p');
    lede.className = 'ax-section__lede';
    lede.textContent =
      'Instrument problems in AI cyber autonomy evaluation, charted by the F1 literature synthesis.';
    sec.appendChild(num);
    sec.appendChild(title);
    sec.appendChild(lede);
    body.appendChild(sec);
  },
  beats: (tl, id) => {
    tl.addLabel('section-in', 0);
    fadeIn(tl, id, '.ax-section__num', 0);
    fadeIn(tl, id, '.ax-section__title', 0.2, { y: 14, duration: 0.6 });
    fadeIn(tl, id, '.ax-section__lede', 0.65);
    tl.to({}, { duration: 1.4 });
  },
});

// ----------------------------------------------------------------------
// §1.1 — Instrument problem definition
// ----------------------------------------------------------------------

const ip1Scene = buildScene({
  id: 'aces-1-instrument-problem',
  title: 'ACES — instrument problem',
  caption: 'Working definition of an instrument problem, from F1.',
  section: '§1 · 1',
  cite: 'F1/lit-review-plan.md:47–54',
  build: (body, d) => {
    const content = d.createElement('div');
    content.className = 'ax-content';

    const eyebrow = d.createElement('div');
    eyebrow.className = 'ax-eyebrow';
    eyebrow.textContent = 'Working definition';

    const heading = d.createElement('h2');
    heading.className = 'ax-heading';
    heading.textContent = 'Instrument problem.';

    const pull = d.createElement('blockquote');
    pull.className = 'ax-pull';
    pull.innerHTML = `&ldquo;A property of an AI/autonomy evaluation's apparatus &mdash; or of how that apparatus is used &mdash; that makes a result difficult to compare, reproduce, or interpret.&rdquo;<cite>F1/lit-review-plan.md:47&ndash;54</cite>`;

    const prose = d.createElement('p');
    prose.className = 'ax-prose';
    prose.innerHTML = `F1 lists the apparatus surfaces in scope: task design, environment design, agent scaffold, observation/action surfaces, hidden assets, evidence capture, provenance, and backend realization ${cite('F1/lit-review-plan.md:47–54')}.`;

    content.appendChild(eyebrow);
    content.appendChild(heading);
    content.appendChild(pull);
    content.appendChild(prose);
    body.appendChild(content);
  },
  beats: (tl, id) => {
    tl.addLabel('ip-in', 0);
    fadeIn(tl, id, '.ax-eyebrow', 0);
    fadeIn(tl, id, '.ax-heading', 0.18, { y: 10, duration: 0.5 });
    fadeIn(tl, id, '.ax-pull', 0.55, { y: 12, duration: 0.55 });
    fadeIn(tl, id, '.ax-prose', 0.95);
    tl.to({}, { duration: 1.6 });
  },
});

// ----------------------------------------------------------------------
// §1.2 — Research questions
// ----------------------------------------------------------------------

const rqScene = buildScene({
  id: 'aces-1-rqs',
  title: 'ACES — F1 research questions',
  caption: 'F1 frames three research questions about instrument problems.',
  section: '§1 · 2',
  cite: 'F1/lit-review-plan.md:35–42',
  build: (body, d) => {
    const content = d.createElement('div');
    content.className = 'ax-content';

    const eyebrow = d.createElement('div');
    eyebrow.className = 'ax-eyebrow';
    eyebrow.textContent = 'F1 research questions';

    const heading = d.createElement('h2');
    heading.className = 'ax-heading';
    heading.textContent = 'Three questions.';

    const dl = d.createElement('dl');
    dl.className = 'ax-defs';
    const rows: readonly { dt: string; dd: string }[] = [
      {
        dt: 'RQ1',
        dd: 'What methodological and instrument problems recur in AI/cyber autonomy evaluation?',
      },
      {
        dt: 'RQ2',
        dd: 'Which problems are caused by task design, environment design, agent scaffold, observation/action surfaces, hidden assets, evidence capture, provenance, or backend realization?',
      },
      {
        dt: 'RQ3',
        dd: 'Which problems can be addressed before backend-specific fidelity claims?',
      },
    ];
    for (const r of rows) {
      const dt = d.createElement('dt');
      dt.textContent = r.dt;
      const dd = d.createElement('dd');
      dd.innerHTML = `${escapeHtml(r.dd)}${cite('F1/lit-review-plan.md:35–42')}`;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }

    content.appendChild(eyebrow);
    content.appendChild(heading);
    content.appendChild(dl);
    body.appendChild(content);
  },
  beats: (tl, id) => {
    tl.addLabel('rq-in', 0);
    fadeIn(tl, id, '.ax-eyebrow', 0);
    fadeIn(tl, id, '.ax-heading', 0.18, { y: 10, duration: 0.5 });
    fadeIn(tl, id, '.ax-defs dt', 0.55, { stagger: 0.12, y: 6 });
    fadeIn(tl, id, '.ax-defs dd', 0.62, { stagger: 0.12, y: 6 });
    tl.to({}, { duration: 1.6 });
  },
});

// ----------------------------------------------------------------------
// §1.3 — F1 corpus
// ----------------------------------------------------------------------

const corpusScene = buildScene({
  id: 'aces-1-corpus',
  title: 'ACES — F1 corpus',
  caption: 'F1 catalogues 15 instrument problems across 135 sources spanning four evidence strata.',
  section: '§1 · 3',
  cite: 'F1/synthesis.md:21–22, 35–36',
  build: (body, d) => {
    const content = d.createElement('div');
    content.className = 'ax-content';

    const eyebrow = d.createElement('div');
    eyebrow.className = 'ax-eyebrow';
    eyebrow.textContent = 'Corpus';

    const heading = d.createElement('h2');
    heading.className = 'ax-heading';
    heading.textContent = 'What F1 looked at.';

    const table = d.createElement('table');
    table.className = 'ax-table ax-table--narrow';
    table.innerHTML = `
      <thead>
        <tr><th>Quantity</th><th>Subject</th></tr>
      </thead>
      <tbody>
        <tr><td><span class="ax-id">15</span></td><td>recurring instrument-problem codes (IP1&ndash;IP15)</td></tr>
        <tr><td><span class="ax-id">135</span></td><td>sources reviewed</td></tr>
        <tr><td><span class="ax-id">4</span></td><td>evidence strata: cyber range · benchmark · agent · simulation</td></tr>
      </tbody>
    `;

    const prose = d.createElement('p');
    prose.className = 'ax-prose';
    prose.innerHTML = `Every instrument problem recurs across all four evidence strata after the integrated audit ${cite('F1/synthesis.md:35–36')}.`;

    content.appendChild(eyebrow);
    content.appendChild(heading);
    content.appendChild(table);
    content.appendChild(prose);
    body.appendChild(content);
  },
  beats: (tl, id) => {
    tl.addLabel('corpus-in', 0);
    fadeIn(tl, id, '.ax-eyebrow', 0);
    fadeIn(tl, id, '.ax-heading', 0.18, { y: 10, duration: 0.5 });
    fadeIn(tl, id, '.ax-table', 0.55, { duration: 0.55 });
    fadeIn(tl, id, '.ax-prose', 0.95);
    tl.to({}, { duration: 1.6 });
  },
});

// ----------------------------------------------------------------------
// §2 — Section title
// ----------------------------------------------------------------------

const section2 = buildScene({
  id: 'aces-2',
  title: 'ACES — §2 title',
  caption: 'Section two. What the SDL is.',
  section: '§2',
  build: (body, d) => {
    const sec = d.createElement('div');
    sec.className = 'ax-section';
    const num = d.createElement('div');
    num.className = 'ax-section__num';
    num.textContent = 'Section 2';
    const title = d.createElement('h2');
    title.className = 'ax-section__title';
    title.textContent = 'What the SDL is.';
    const lede = d.createElement('p');
    lede.className = 'ax-section__lede';
    lede.textContent =
      'Definition, what the repository separates, and the explicit scope boundary.';
    sec.appendChild(num);
    sec.appendChild(title);
    sec.appendChild(lede);
    body.appendChild(sec);
  },
  beats: (tl, id) => {
    tl.addLabel('section-in', 0);
    fadeIn(tl, id, '.ax-section__num', 0);
    fadeIn(tl, id, '.ax-section__title', 0.2, { y: 14, duration: 0.6 });
    fadeIn(tl, id, '.ax-section__lede', 0.65);
    tl.to({}, { duration: 1.4 });
  },
});

// ----------------------------------------------------------------------
// §2.1 — Definition
// ----------------------------------------------------------------------

const definitionScene = buildScene({
  id: 'aces-2-definition',
  title: 'ACES — definition',
  caption:
    'ACES is a backend-agnostic SDL, a Python reference implementation, and a contract surface.',
  section: '§2 · 1',
  cite: 'README.md:1–5',
  build: (body, d) => {
    const content = d.createElement('div');
    content.className = 'ax-content';

    const eyebrow = d.createElement('div');
    eyebrow.className = 'ax-eyebrow';
    eyebrow.textContent = 'Definition · verbatim';

    const heading = d.createElement('h2');
    heading.className = 'ax-heading';
    heading.textContent = 'What ACES is.';

    const pull = d.createElement('blockquote');
    pull.className = 'ax-pull';
    pull.innerHTML =
      '&ldquo;Agentic Cyber Environment System (ACES) is a backend-agnostic scenario description language, Python reference implementation, and contract surface for cyber range scenarios and experiments.&rdquo;<cite>README.md:1&ndash;5</cite>';

    content.appendChild(eyebrow);
    content.appendChild(heading);
    content.appendChild(pull);
    body.appendChild(content);
  },
  beats: (tl, id) => {
    tl.addLabel('def-in', 0);
    fadeIn(tl, id, '.ax-eyebrow', 0);
    fadeIn(tl, id, '.ax-heading', 0.18, { y: 10, duration: 0.5 });
    fadeIn(tl, id, '.ax-pull', 0.55, { y: 14, duration: 0.6 });
    tl.to({}, { duration: 1.6 });
  },
});

// ----------------------------------------------------------------------
// §2.2 — What an SDL document is
// ----------------------------------------------------------------------

const sdlDocScene = buildScene({
  id: 'aces-2-sdl-doc',
  title: 'ACES — SDL document',
  caption: 'An SDL document is a declarative scenario description.',
  section: '§2 · 2',
  cite: 'README.md:39–42',
  build: (body, d) => {
    const content = d.createElement('div');
    content.className = 'ax-content';

    const eyebrow = d.createElement('div');
    eyebrow.className = 'ax-eyebrow';
    eyebrow.textContent = 'SDL document';

    const heading = d.createElement('h2');
    heading.className = 'ax-heading';
    heading.textContent = 'What it describes.';

    const prose = d.createElement('p');
    prose.className = 'ax-prose';
    prose.innerHTML = `An SDL document is a &ldquo;declarative scenario document&rdquo; describing topology, hosts, services, identities, content, relationships, agents, objectives, workflows, variables, and evaluation material &mdash; without directly describing a specific backend's infrastructure primitives ${cite('README.md:39–42')}.`;

    content.appendChild(eyebrow);
    content.appendChild(heading);
    content.appendChild(prose);
    body.appendChild(content);
  },
  beats: (tl, id) => {
    tl.addLabel('sdl-in', 0);
    fadeIn(tl, id, '.ax-eyebrow', 0);
    fadeIn(tl, id, '.ax-heading', 0.18, { y: 10, duration: 0.5 });
    fadeIn(tl, id, '.ax-prose', 0.55);
    tl.to({}, { duration: 1.4 });
  },
});

// ----------------------------------------------------------------------
// §2.3 — What the repository separates
// ----------------------------------------------------------------------

const separatesScene = buildScene({
  id: 'aces-2-separates',
  title: 'ACES — separation',
  caption:
    'The repository separates authored scenario meaning from processors, backends, participant implementations, runtime state, and archived evidence.',
  section: '§2 · 3',
  cite: 'README.md:7–12',
  build: (body, d) => {
    const content = d.createElement('div');
    content.className = 'ax-content';

    const eyebrow = d.createElement('div');
    eyebrow.className = 'ax-eyebrow';
    eyebrow.textContent = 'Separation';

    const heading = d.createElement('h2');
    heading.className = 'ax-heading';
    heading.textContent = 'What the repository separates.';

    const prose = d.createElement('p');
    prose.className = 'ax-prose';
    prose.innerHTML = `The repository separates &ldquo;authored scenario meaning from processors, backends, participant implementations, runtime state, and archived evidence&rdquo; ${cite('README.md:7–12')}.`;

    const dl = d.createElement('dl');
    dl.className = 'ax-defs';
    const rows: readonly { dt: string; dd: string }[] = [
      { dt: 'authoring', dd: 'SDL — declarative scenario meaning.' },
      { dt: 'processing', dd: 'Instantiates SDL, compiles runtime models, plans execution.' },
      {
        dt: 'backend',
        dd: 'Realizes scenario targets. Contracts and stubs present; production backends separate.',
      },
      { dt: 'participant', dd: 'Agent / policy / script / human-control proxy implementations.' },
      { dt: 'runtime state', dd: 'Live execution surface.' },
      { dt: 'evidence', dd: 'Recorded observations, results, history.' },
    ];
    for (const r of rows) {
      const dt = d.createElement('dt');
      dt.textContent = r.dt;
      const dd = d.createElement('dd');
      dd.textContent = r.dd;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }

    content.appendChild(eyebrow);
    content.appendChild(heading);
    content.appendChild(prose);
    content.appendChild(dl);
    body.appendChild(content);
  },
  beats: (tl, id) => {
    tl.addLabel('sep-in', 0);
    fadeIn(tl, id, '.ax-eyebrow', 0);
    fadeIn(tl, id, '.ax-heading', 0.18, { y: 10, duration: 0.5 });
    fadeIn(tl, id, '.ax-prose', 0.55);
    fadeIn(tl, id, '.ax-defs dt', 0.95, { stagger: 0.08, y: 6 });
    fadeIn(tl, id, '.ax-defs dd', 1.0, { stagger: 0.08, y: 6 });
    tl.to({}, { duration: 1.6 });
  },
});

// ----------------------------------------------------------------------
// §2.4 — What it is not
// ----------------------------------------------------------------------

const notScene = buildScene({
  id: 'aces-2-not',
  title: 'ACES — scope boundary',
  caption: 'What the aces-sdl repository explicitly is not.',
  section: '§2 · 4',
  cite: 'README.md:14–20 · limitations.md:74–77',
  build: (body, d) => {
    const content = d.createElement('div');
    content.className = 'ax-content';

    const eyebrow = d.createElement('div');
    eyebrow.className = 'ax-eyebrow';
    eyebrow.textContent = 'Scope boundary';

    const heading = d.createElement('h2');
    heading.className = 'ax-heading';
    heading.textContent = 'What this repository is not.';

    const table = d.createElement('table');
    table.className = 'ax-table';
    table.innerHTML = `
      <thead>
        <tr><th>Statement</th><th>Source</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>Not a managed cyber range; no production backend included.</td>
          <td><span class="ax-cite">README.md:17&ndash;20</span></td>
        </tr>
        <tr>
          <td>Backend contracts, stubs, conformance checks, and examples are present; deployable backends remain separate implementations.</td>
          <td><span class="ax-cite">README.md:17&ndash;20</span></td>
        </tr>
        <tr>
          <td>Not a generic scenario-ingestion layer; the SDL loader is intentionally thin. Non-SDL entrypoints are outside scope.</td>
          <td><span class="ax-cite">docs/explain/sdl/limitations.md:74&ndash;77</span></td>
        </tr>
        <tr>
          <td>Intended as reference implementation code &mdash; to be read, tested, and used &mdash; not as a product surface.</td>
          <td><span class="ax-cite">README.md:14&ndash;16</span></td>
        </tr>
      </tbody>
    `;

    content.appendChild(eyebrow);
    content.appendChild(heading);
    content.appendChild(table);
    body.appendChild(content);
  },
  beats: (tl, id) => {
    tl.addLabel('not-in', 0);
    fadeIn(tl, id, '.ax-eyebrow', 0);
    fadeIn(tl, id, '.ax-heading', 0.18, { y: 10, duration: 0.5 });
    fadeIn(tl, id, '.ax-table', 0.55, { duration: 0.55 });
    tl.to({}, { duration: 1.6 });
  },
});

// ----------------------------------------------------------------------
// §2.5 — Known deferrals
// ----------------------------------------------------------------------

const deferredScene = buildScene({
  id: 'aces-2-deferred',
  title: 'ACES — deferred',
  caption: 'Known deferred concerns in the SDL specification layer.',
  section: '§2 · 5',
  cite: 'docs/explain/sdl/limitations.md:46–60',
  build: (body, d) => {
    const content = d.createElement('div');
    content.className = 'ax-content';

    const eyebrow = d.createElement('div');
    eyebrow.className = 'ax-eyebrow';
    eyebrow.textContent = 'Deferred · specification layer';

    const heading = d.createElement('h2');
    heading.className = 'ax-heading';
    heading.textContent = 'Items currently out of scope.';

    const table = d.createElement('table');
    table.className = 'ax-table';
    table.innerHTML = `
      <thead>
        <tr><th>Deferred item</th><th>Candidate reference / model</th></tr>
      </thead>
      <tbody>
        <tr><td>Hosted registry operations / ecosystem distribution</td><td>Terraform registry; OCI artifact delivery</td></tr>
        <tr><td>Manual compensation APIs and advanced rollback patterns</td><td>CACAO v2.0; saga patterns</td></tr>
        <tr><td>Temporal operators</td><td>STIX-style FOLLOWEDBY / WITHIN</td></tr>
        <tr><td>Full time and clock model</td><td>Time domains; clock authority; pacing/dilation policy</td></tr>
        <tr><td>Full solver-backed verification</td><td>Global proof-style verification</td></tr>
        <tr><td>Full participant behavior surface</td><td>Tool / affordance declarations; decision-surface exposure</td></tr>
        <tr><td>Scenario-native observability and authored evidence requirements</td><td>OpenRange; OCSF-informed models</td></tr>
        <tr><td>User behavior profiles</td><td>CybORG Green agents</td></tr>
        <tr><td>Multi-tenancy</td><td>Multiple independent exercises sharing infrastructure</td></tr>
      </tbody>
    `;

    content.appendChild(eyebrow);
    content.appendChild(heading);
    content.appendChild(table);
    body.appendChild(content);
  },
  beats: (tl, id) => {
    tl.addLabel('deferred-in', 0);
    fadeIn(tl, id, '.ax-eyebrow', 0);
    fadeIn(tl, id, '.ax-heading', 0.18, { y: 10, duration: 0.5 });
    fadeIn(tl, id, '.ax-table', 0.55, { duration: 0.6 });
    tl.to({}, { duration: 1.6 });
  },
});

// ----------------------------------------------------------------------
// §3 — Section title
// ----------------------------------------------------------------------

const section3 = buildScene({
  id: 'aces-3',
  title: 'ACES — §3 title',
  caption: 'Section three. Repository structure.',
  section: '§3',
  build: (body, d) => {
    const sec = d.createElement('div');
    sec.className = 'ax-section';
    const num = d.createElement('div');
    num.className = 'ax-section__num';
    num.textContent = 'Section 3';
    const title = d.createElement('h2');
    title.className = 'ax-section__title';
    title.textContent = 'Repository structure.';
    const lede = d.createElement('p');
    lede.className = 'ax-section__lede';
    lede.textContent =
      'Top-level directories, authority boundary, and the requirement-identifier convention.';
    sec.appendChild(num);
    sec.appendChild(title);
    sec.appendChild(lede);
    body.appendChild(sec);
  },
  beats: (tl, id) => {
    tl.addLabel('section-in', 0);
    fadeIn(tl, id, '.ax-section__num', 0);
    fadeIn(tl, id, '.ax-section__title', 0.2, { y: 14, duration: 0.6 });
    fadeIn(tl, id, '.ax-section__lede', 0.65);
    tl.to({}, { duration: 1.4 });
  },
});

// ----------------------------------------------------------------------
// §3.1 — Top-level layout
// ----------------------------------------------------------------------

const layoutScene = buildScene({
  id: 'aces-3-layout',
  title: 'ACES — layout',
  caption: 'Top-level directories and their stated purposes.',
  section: '§3 · 1',
  cite: 'README.md:118–127',
  build: (body, d) => {
    const content = d.createElement('div');
    content.className = 'ax-content';

    const eyebrow = d.createElement('div');
    eyebrow.className = 'ax-eyebrow';
    eyebrow.textContent = 'Top-level directories';

    const heading = d.createElement('h2');
    heading.className = 'ax-heading';
    heading.textContent = 'Eight roots.';

    const table = d.createElement('table');
    table.className = 'ax-table ax-table--narrow';
    table.innerHTML = `
      <thead>
        <tr><th>Path</th><th>Stated role</th></tr>
      </thead>
      <tbody>
        <tr><td><span class="ax-path">specs/</span></td><td>Normative prose and formal specification material.</td></tr>
        <tr><td><span class="ax-path">contracts/</span></td><td>Published schemas, fixtures, manifests, and profiles.</td></tr>
        <tr><td><span class="ax-path">implementations/</span></td><td>Reference implementations and their local tooling.</td></tr>
        <tr><td><span class="ax-path">examples/</span></td><td>Worked SDL scenarios; reusable authoring templates and patterns.</td></tr>
        <tr><td><span class="ax-path">docs/</span></td><td>Explanatory documentation, API docs, architecture decisions.</td></tr>
        <tr><td><span class="ax-path">research/</span></td><td>Supporting literature and reference ecosystem material.</td></tr>
        <tr><td><span class="ax-path">tools/</span></td><td>Repository maintenance, policy, and publication tooling.</td></tr>
        <tr><td><span class="ax-path">changelog.d/</span></td><td>towncrier release note fragments.</td></tr>
      </tbody>
    `;

    content.appendChild(eyebrow);
    content.appendChild(heading);
    content.appendChild(table);
    body.appendChild(content);
  },
  beats: (tl, id) => {
    tl.addLabel('layout-in', 0);
    fadeIn(tl, id, '.ax-eyebrow', 0);
    fadeIn(tl, id, '.ax-heading', 0.18, { y: 10, duration: 0.5 });
    fadeIn(tl, id, '.ax-table', 0.55, { duration: 0.6 });
    tl.to({}, { duration: 1.6 });
  },
});

// ----------------------------------------------------------------------
// §3.2 — Authority
// ----------------------------------------------------------------------

const authorityScene = buildScene({
  id: 'aces-3-authority',
  title: 'ACES — authority',
  caption: 'Authority boundary identifies which roots carry normative weight.',
  section: '§3 · 2',
  cite: 'specs/README.md:13–14 · ADR-009 · ADR-019',
  build: (body, d) => {
    const content = d.createElement('div');
    content.className = 'ax-content';

    const eyebrow = d.createElement('div');
    eyebrow.className = 'ax-eyebrow';
    eyebrow.textContent = 'Authority';

    const heading = d.createElement('h2');
    heading.className = 'ax-heading';
    heading.textContent = 'Authority boundary.';

    const prose = d.createElement('p');
    prose.className = 'ax-prose';
    prose.innerHTML = `<span class="ax-id">specs/authority/authority-boundary.yaml</span> is the canonical authority manifest (<span class="ax-id">ASR-517</span>) ${cite('specs/README.md:13–14')}. It identifies which repository roots carry normative authority. The contracts boundary &mdash; <span class="ax-id">contracts/</span> &mdash; is the authority surface for machine-readable contracts, fixtures, and profiles ${cite('contracts/README.md:31–33')}.`;

    const dl = d.createElement('dl');
    dl.className = 'ax-defs';
    const rows: readonly { dt: string; dd: string }[] = [
      { dt: 'ADR-009', dd: 'Normative artifact authority and repository structure.' },
      { dt: 'ADR-019', dd: 'Authority manifest format and governance.' },
      {
        dt: 'specs/',
        dd: 'Normative documents defining repository semantics independent of any single implementation.',
      },
      { dt: 'contracts/', dd: 'Authority boundary for published machine-readable artifacts.' },
    ];
    for (const r of rows) {
      const dt = d.createElement('dt');
      dt.textContent = r.dt;
      const dd = d.createElement('dd');
      dd.textContent = r.dd;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }

    content.appendChild(eyebrow);
    content.appendChild(heading);
    content.appendChild(prose);
    content.appendChild(dl);
    body.appendChild(content);
  },
  beats: (tl, id) => {
    tl.addLabel('auth-in', 0);
    fadeIn(tl, id, '.ax-eyebrow', 0);
    fadeIn(tl, id, '.ax-heading', 0.18, { y: 10, duration: 0.5 });
    fadeIn(tl, id, '.ax-prose', 0.55);
    fadeIn(tl, id, '.ax-defs dt', 0.95, { stagger: 0.08, y: 6 });
    fadeIn(tl, id, '.ax-defs dd', 1.0, { stagger: 0.08, y: 6 });
    tl.to({}, { duration: 1.6 });
  },
});

// ----------------------------------------------------------------------
// §3.3 — Identifier conventions
// ----------------------------------------------------------------------

const identifiersScene = buildScene({
  id: 'aces-3-identifiers',
  title: 'ACES — identifiers',
  caption: 'Requirement identifiers use a domain prefix.',
  section: '§3 · 3',
  cite: 'ADR-016 · AGENTS.md · .ground-control.yaml',
  build: (body, d) => {
    const content = d.createElement('div');
    content.className = 'ax-content';

    const eyebrow = d.createElement('div');
    eyebrow.className = 'ax-eyebrow';
    eyebrow.textContent = 'Identifier conventions';

    const heading = d.createElement('h2');
    heading.className = 'ax-heading';
    heading.textContent = 'Domain-prefixed requirement IDs.';

    const table = d.createElement('table');
    table.className = 'ax-table ax-table--codes';
    table.innerHTML = `
      <thead>
        <tr><th>Prefix</th><th>Domain</th><th>Example</th></tr>
      </thead>
      <tbody>
        <tr><td><span class="ax-id">SEM-*</span></td><td>Semantic layer</td><td><span class="ax-id">SEM-200</span> Shared Semantic Integrity</td></tr>
        <tr><td><span class="ax-id">ASR-*</span></td><td>Assurance</td><td><span class="ax-id">ASR-517</span> authority manifest</td></tr>
        <tr><td><span class="ax-id">AUT-*</span></td><td>Authoring</td><td><span class="ax-id">AUT-806</span> template / pattern library</td></tr>
        <tr><td><span class="ax-id">API-*</span></td><td>API / runtime contract</td><td><span class="ax-id">API-400</span> series</td></tr>
        <tr><td><span class="ax-id">RUN-*</span></td><td>Runtime</td><td><span class="ax-id">RUN-301</span> series</td></tr>
        <tr><td><span class="ax-id">GOV-*</span></td><td>Governance</td><td><span class="ax-id">GOV-918</span></td></tr>
        <tr><td><span class="ax-id">ACT-*</span></td><td>Actions / events</td><td><span class="ax-id">ACT-602</span></td></tr>
      </tbody>
    `;

    const prose = d.createElement('p');
    prose.className = 'ax-prose';
    prose.innerHTML = `Requirements are tracked in Ground Control (<span class="ax-id">.ground-control.yaml</span>). The semantic layer carries ~28 SEM-2xx child requirements under the SEM-200 umbrella ${cite('docs/decisions/adrs/adr-016-semantic-layer-scope-and-coverage-model.md')}.`;

    content.appendChild(eyebrow);
    content.appendChild(heading);
    content.appendChild(table);
    content.appendChild(prose);
    body.appendChild(content);
  },
  beats: (tl, id) => {
    tl.addLabel('ids-in', 0);
    fadeIn(tl, id, '.ax-eyebrow', 0);
    fadeIn(tl, id, '.ax-heading', 0.18, { y: 10, duration: 0.5 });
    fadeIn(tl, id, '.ax-table', 0.55, { duration: 0.6 });
    fadeIn(tl, id, '.ax-prose', 1.1);
    tl.to({}, { duration: 1.6 });
  },
});

// ----------------------------------------------------------------------
// §4 — Section title
// ----------------------------------------------------------------------

const section4 = buildScene({
  id: 'aces-4',
  title: 'ACES — §4 title',
  caption: 'Section four. Contracts and conformance.',
  section: '§4',
  build: (body, d) => {
    const sec = d.createElement('div');
    sec.className = 'ax-section';
    const num = d.createElement('div');
    num.className = 'ax-section__num';
    num.textContent = 'Section 4';
    const title = d.createElement('h2');
    title.className = 'ax-section__title';
    title.textContent = 'Contracts and conformance.';
    const lede = d.createElement('p');
    lede.className = 'ax-section__lede';
    lede.textContent = 'The published machine-readable surface and how it is enforced.';
    sec.appendChild(num);
    sec.appendChild(title);
    sec.appendChild(lede);
    body.appendChild(sec);
  },
  beats: (tl, id) => {
    tl.addLabel('section-in', 0);
    fadeIn(tl, id, '.ax-section__num', 0);
    fadeIn(tl, id, '.ax-section__title', 0.2, { y: 14, duration: 0.6 });
    fadeIn(tl, id, '.ax-section__lede', 0.65);
    tl.to({}, { duration: 1.4 });
  },
});

// ----------------------------------------------------------------------
// §4.1 — Contracts surface
// ----------------------------------------------------------------------

const contractsScene = buildScene({
  id: 'aces-4-contracts',
  title: 'ACES — contracts',
  caption: 'contracts/ holds schemas, profiles, fixtures, and the publication manifest.',
  section: '§4 · 1',
  cite: 'contracts/README.md · contracts/schemas/README.md',
  build: (body, d) => {
    const content = d.createElement('div');
    content.className = 'ax-content';

    const eyebrow = d.createElement('div');
    eyebrow.className = 'ax-eyebrow';
    eyebrow.textContent = 'contracts/';

    const heading = d.createElement('h2');
    heading.className = 'ax-heading';
    heading.textContent = 'The published machine-readable surface.';

    const table = d.createElement('table');
    table.className = 'ax-table ax-table--narrow';
    table.innerHTML = `
      <thead>
        <tr><th>Path</th><th>Content</th></tr>
      </thead>
      <tbody>
        <tr><td><span class="ax-path">contracts/schemas/</span></td><td>Language-neutral JSON Schema documents (SDL authoring input, scenario instantiation, apparatus manifests v1/v2, concept-authority catalogs, controlled vocabularies, reference models, semantic profiles, runtime snapshots, workflow / evaluator result envelopes).</td></tr>
        <tr><td><span class="ax-path">contracts/profiles/backend/</span></td><td>Four backend capability profiles: provisioning-only, orchestration-capable, orchestration-evaluation, full-remote-control-plane.</td></tr>
        <tr><td><span class="ax-path">contracts/profiles/semantic/</span></td><td>Reference semantic profile (<span class="ax-id">reference-stack-v1</span>).</td></tr>
        <tr><td><span class="ax-path">contracts/fixtures/</span></td><td>Canonical fixture corpus, organised by contract id with <span class="ax-id">valid/</span> and <span class="ax-id">invalid/</span> JSON exemplars.</td></tr>
        <tr><td><span class="ax-path">schema-publication-manifest.json</span></td><td>Authoritative publication inventory; the contracts verification gate checks parity with <span class="ax-path">contracts/schemas/</span>.</td></tr>
      </tbody>
    `;

    content.appendChild(eyebrow);
    content.appendChild(heading);
    content.appendChild(table);
    body.appendChild(content);
  },
  beats: (tl, id) => {
    tl.addLabel('contracts-in', 0);
    fadeIn(tl, id, '.ax-eyebrow', 0);
    fadeIn(tl, id, '.ax-heading', 0.18, { y: 10, duration: 0.5 });
    fadeIn(tl, id, '.ax-table', 0.55, { duration: 0.6 });
    tl.to({}, { duration: 1.6 });
  },
});

// ----------------------------------------------------------------------
// §4.2 — Conformance
// ----------------------------------------------------------------------

const conformanceScene = buildScene({
  id: 'aces-4-conformance',
  title: 'ACES — conformance',
  caption:
    'Conformance is implementation-side. It validates backend manifests against fixtures and capability profiles under closed-world semantics.',
  section: '§4 · 2',
  cite: 'docs/explain/reference/backend-conformance.md:5–32',
  build: (body, d) => {
    const content = d.createElement('div');
    content.className = 'ax-content';

    const eyebrow = d.createElement('div');
    eyebrow.className = 'ax-eyebrow';
    eyebrow.textContent = 'Conformance';

    const heading = d.createElement('h2');
    heading.className = 'ax-heading';
    heading.textContent = 'How the contract surface is enforced.';

    const prose = d.createElement('p');
    prose.className = 'ax-prose';
    prose.innerHTML = `Conformance is implemented as a verifier under <span class="ax-path">implementations/python/packages/aces_conformance/</span>, not as a normative artifact under <span class="ax-path">contracts/</span> ${cite('docs/explain/reference/backend-conformance.md:5–8')}.`;

    const dl = d.createElement('dl');
    dl.className = 'ax-defs';
    const rows: readonly { dt: string; dd: string }[] = [
      {
        dt: 'fixture corpus',
        dd: 'contracts/fixtures/**/<contract-id>/{valid,invalid}/*.json — the canonical inputs.',
      },
      {
        dt: 'profile corpus',
        dd: 'contracts/profiles/backend/*.json — the canonical capability declarations.',
      },
      {
        dt: 'manifest validation',
        dd: 'backend_manifest_payload() against backend-manifest-v2.',
      },
      {
        dt: 'closed-world',
        dd: 'Pydantic ContractModel descendants with extra="forbid" reject unknown keys.',
      },
      {
        dt: 'authority validation',
        dd: 'supported_contract_versions, concept bindings, capability vocabulary checked against authority.',
      },
    ];
    for (const r of rows) {
      const dt = d.createElement('dt');
      dt.textContent = r.dt;
      const dd = d.createElement('dd');
      dd.textContent = r.dd;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }

    content.appendChild(eyebrow);
    content.appendChild(heading);
    content.appendChild(prose);
    content.appendChild(dl);
    body.appendChild(content);
  },
  beats: (tl, id) => {
    tl.addLabel('conf-in', 0);
    fadeIn(tl, id, '.ax-eyebrow', 0);
    fadeIn(tl, id, '.ax-heading', 0.18, { y: 10, duration: 0.5 });
    fadeIn(tl, id, '.ax-prose', 0.55);
    fadeIn(tl, id, '.ax-defs dt', 0.95, { stagger: 0.08, y: 6 });
    fadeIn(tl, id, '.ax-defs dd', 1.0, { stagger: 0.08, y: 6 });
    tl.to({}, { duration: 1.6 });
  },
});

// ----------------------------------------------------------------------
// §4.3 — Verification gate
// ----------------------------------------------------------------------

const gateScene = buildScene({
  id: 'aces-4-gate',
  title: 'ACES — verification',
  caption: 'nox -s verify runs the canonical verification graph required for pull requests.',
  section: '§4 · 3',
  cite: 'README.md:162–169',
  build: (body, d) => {
    const content = d.createElement('div');
    content.className = 'ax-content';

    const eyebrow = d.createElement('div');
    eyebrow.className = 'ax-eyebrow';
    eyebrow.textContent = 'Verification';

    const heading = d.createElement('h2');
    heading.className = 'ax-heading';
    heading.textContent = 'The canonical PR gate.';

    const prose = d.createElement('p');
    prose.className = 'ax-prose';
    prose.innerHTML = `<span class="ax-id">nox -s verify</span> runs the canonical verification graph required for pull requests ${cite('README.md:162–169')}. Repository policy is enforced by tooling that lives under <span class="ax-path">tools/</span>.`;

    const dl = d.createElement('dl');
    dl.className = 'ax-defs';
    const rows: readonly { dt: string; dd: string }[] = [
      { dt: 'check_authority_boundary.py', dd: 'Enforces the authority manifest (ASR-517).' },
      {
        dt: 'check_example_library.py',
        dd: 'Enforces the example template/pattern catalog (AUT-806).',
      },
      { dt: 'check_repo_policy.py', dd: 'Enforces general repository policy.' },
      {
        dt: 'check_assurance_policy.py',
        dd: 'Enforces classification-based assurance policy (ADR-018).',
      },
    ];
    for (const r of rows) {
      const dt = d.createElement('dt');
      dt.textContent = r.dt;
      const dd = d.createElement('dd');
      dd.textContent = r.dd;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }

    content.appendChild(eyebrow);
    content.appendChild(heading);
    content.appendChild(prose);
    content.appendChild(dl);
    body.appendChild(content);
  },
  beats: (tl, id) => {
    tl.addLabel('gate-in', 0);
    fadeIn(tl, id, '.ax-eyebrow', 0);
    fadeIn(tl, id, '.ax-heading', 0.18, { y: 10, duration: 0.5 });
    fadeIn(tl, id, '.ax-prose', 0.55);
    fadeIn(tl, id, '.ax-defs dt', 0.95, { stagger: 0.08, y: 6 });
    fadeIn(tl, id, '.ax-defs dd', 1.0, { stagger: 0.08, y: 6 });
    tl.to({}, { duration: 1.6 });
  },
});

// ----------------------------------------------------------------------
// §5 — Section title
// ----------------------------------------------------------------------

const section5 = buildScene({
  id: 'aces-5',
  title: 'ACES — §5 title',
  caption: 'Section five. Reading after this talk.',
  section: '§5',
  build: (body, d) => {
    const sec = d.createElement('div');
    sec.className = 'ax-section';
    const num = d.createElement('div');
    num.className = 'ax-section__num';
    num.textContent = 'Section 5';
    const title = d.createElement('h2');
    title.className = 'ax-section__title';
    title.textContent = 'Reading after this talk.';
    const lede = d.createElement('p');
    lede.className = 'ax-section__lede';
    lede.textContent = 'A traversal order through the repository.';
    sec.appendChild(num);
    sec.appendChild(title);
    sec.appendChild(lede);
    body.appendChild(sec);
  },
  beats: (tl, id) => {
    tl.addLabel('section-in', 0);
    fadeIn(tl, id, '.ax-section__num', 0);
    fadeIn(tl, id, '.ax-section__title', 0.2, { y: 14, duration: 0.6 });
    fadeIn(tl, id, '.ax-section__lede', 0.65);
    tl.to({}, { duration: 1.4 });
  },
});

// ----------------------------------------------------------------------
// §5.1 — Next reads
// ----------------------------------------------------------------------

const readsScene = buildScene({
  id: 'aces-5-reads',
  title: 'ACES — next reads',
  caption: 'A short reading order for someone new to the repository.',
  section: '§5 · 1',
  build: (body, d) => {
    const content = d.createElement('div');
    content.className = 'ax-content';

    const eyebrow = d.createElement('div');
    eyebrow.className = 'ax-eyebrow';
    eyebrow.textContent = 'Reading order';

    const heading = d.createElement('h2');
    heading.className = 'ax-heading';
    heading.textContent = 'Where to look next.';

    const list = d.createElement('ol');
    list.className = 'ax-toc';
    const rows: readonly { title: string; sub: string }[] = [
      { title: 'README.md', sub: 'Definition, repo layout, lineage.' },
      {
        title: 'docs/explain/reference/glossary.md',
        sub: 'Normative vocabulary; ~30 defined terms.',
      },
      {
        title: 'docs/decisions/adrs/adr-001-scenario-description-language.md',
        sub: 'SDL design rationale; sections; validation model.',
      },
      {
        title: 'docs/explain/sdl/limitations.md',
        sub: 'Expressiveness gaps; validated coverage; deferrals.',
      },
      {
        title: 'docs/decisions/adrs/adr-009-...repository-structure.md',
        sub: 'Authority boundary; specs vs implementations vs contracts.',
      },
      {
        title: 'specs/concept-authority/concept-authority.md',
        sub: 'Three-layer concept model; relation to UCO / STIX / CACAO.',
      },
      {
        title: 'docs/explain/reference/backend-conformance.md',
        sub: 'Conformance architecture and what is enforced.',
      },
      {
        title: 'docs/decisions/adrs/adr-016-semantic-layer-...-model.md',
        sub: 'Semantic layer scope; SEM-200 umbrella and child requirements.',
      },
      {
        title: 'docs/explain/sdl/lineage.md',
        sub: 'Lineage from OCR SDL, CybORG, CACAO, STIX, OCSF, TENA, HLA, SISO.',
      },
      {
        title: 'research/program/aces-instrument-paper-details.md',
        sub: 'Instrument validation papers (A1, A2, ...). Bridges to F1.',
      },
    ];
    rows.forEach((r, i) => {
      const row = d.createElement('li');
      row.className = 'ax-toc__row';
      const num = d.createElement('span');
      num.className = 'ax-toc__num';
      num.textContent = String(i + 1).padStart(2, '0');
      const text = d.createElement('span');
      text.className = 'ax-toc__text';
      text.innerHTML = `<span class="ax-id" style="font-size:0.82em">${escapeHtml(r.title)}</span><small>${escapeHtml(r.sub)}</small>`;
      row.appendChild(num);
      row.appendChild(text);
      list.appendChild(row);
    });

    content.appendChild(eyebrow);
    content.appendChild(heading);
    content.appendChild(list);
    body.appendChild(content);
  },
  beats: (tl, id) => {
    tl.addLabel('reads-in', 0);
    fadeIn(tl, id, '.ax-eyebrow', 0);
    fadeIn(tl, id, '.ax-heading', 0.18, { y: 10, duration: 0.5 });
    fadeIn(tl, id, '.ax-toc__num', 0.55, { stagger: 0.06, y: 6 });
    fadeIn(tl, id, '.ax-toc__text', 0.6, { stagger: 0.06, y: 6 });
    tl.to({}, { duration: 1.6 });
  },
});

// ----------------------------------------------------------------------
// References appendix
// ----------------------------------------------------------------------

const referencesScene = buildScene({
  id: 'aces-refs',
  title: 'ACES — references',
  caption: 'Cited documents.',
  section: 'references · end',
  holdForever: true,
  build: (body, d) => {
    const content = d.createElement('div');
    content.className = 'ax-content';

    const eyebrow = d.createElement('div');
    eyebrow.className = 'ax-eyebrow';
    eyebrow.textContent = 'References';

    const heading = d.createElement('h2');
    heading.className = 'ax-heading';
    heading.textContent = 'Cited documents.';

    const list = d.createElement('ul');
    list.className = 'ax-refs';
    const rows: readonly { id: string; title: string; path: string }[] = [
      { id: 'R1', title: 'README', path: 'aces-sdl/README.md' },
      { id: 'R2', title: 'specs/ README', path: 'aces-sdl/specs/README.md' },
      { id: 'R3', title: 'contracts/ README', path: 'aces-sdl/contracts/README.md' },
      {
        id: 'R4',
        title: 'contracts/schemas/ README',
        path: 'aces-sdl/contracts/schemas/README.md',
      },
      { id: 'R5', title: 'Glossary', path: 'aces-sdl/docs/explain/reference/glossary.md' },
      {
        id: 'R6',
        title: 'SDL design (ADR-001)',
        path: 'aces-sdl/docs/decisions/adrs/adr-001-scenario-description-language.md',
      },
      {
        id: 'R7',
        title: 'Authority and repository structure (ADR-009)',
        path: 'aces-sdl/docs/decisions/adrs/adr-009-normative-artifact-authority-and-repository-structure.md',
      },
      {
        id: 'R8',
        title: 'Concept authority',
        path: 'aces-sdl/specs/concept-authority/concept-authority.md',
      },
      {
        id: 'R9',
        title: 'Backend conformance',
        path: 'aces-sdl/docs/explain/reference/backend-conformance.md',
      },
      {
        id: 'R10',
        title: 'Semantic layer model (ADR-016)',
        path: 'aces-sdl/docs/decisions/adrs/adr-016-semantic-layer-scope-and-coverage-model.md',
      },
      { id: 'R11', title: 'SDL limitations', path: 'aces-sdl/docs/explain/sdl/limitations.md' },
      { id: 'R12', title: 'SDL lineage', path: 'aces-sdl/docs/explain/sdl/lineage.md' },
      {
        id: 'R13',
        title: 'F1 literature-review plan',
        path: 'research/program/lit-review/F1/lit-review-plan.md',
      },
      { id: 'R14', title: 'F1 synthesis', path: 'research/program/lit-review/F1/synthesis.md' },
      {
        id: 'R15',
        title: 'ACES instrument paper details',
        path: 'research/program/aces-instrument-paper-details.md',
      },
    ];
    for (const r of rows) {
      const li = d.createElement('li');
      li.innerHTML = `<span class="ax-refs__id">${escapeHtml(r.id)}</span>${escapeHtml(r.title)} <span class="ax-refs__path">${escapeHtml(r.path)}</span>`;
      list.appendChild(li);
    }

    content.appendChild(eyebrow);
    content.appendChild(heading);
    content.appendChild(list);
    body.appendChild(content);
  },
  beats: (tl, id) => {
    tl.addLabel('refs-in', 0);
    fadeIn(tl, id, '.ax-eyebrow', 0);
    fadeIn(tl, id, '.ax-heading', 0.18, { y: 10, duration: 0.5 });
    fadeIn(tl, id, '.ax-refs li', 0.5, { stagger: 0.025, y: 4, duration: 0.35 });
    tl.to({}, { duration: 1.4 });
  },
});

// ----------------------------------------------------------------------
// Export
// ----------------------------------------------------------------------

export const ACES_ECOSYSTEM_INTRO_SCENES: readonly SceneModule[] = [
  coverScene,
  nonClaimScene,
  tocScene,
  section1,
  ip1Scene,
  rqScene,
  corpusScene,
  section2,
  definitionScene,
  sdlDocScene,
  separatesScene,
  notScene,
  deferredScene,
  section3,
  layoutScene,
  authorityScene,
  identifiersScene,
  section4,
  contractsScene,
  conformanceScene,
  gateScene,
  section5,
  readsScene,
  referencesScene,
];
