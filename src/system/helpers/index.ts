// Public surface of pulsar L2 helpers — re-exports for ergonomic
// imports from templates and decks.

export { aSleep, holdUntilAdvance, schedule, sleep, startInterval } from './timing';
export type { ASleepOptions } from './timing';

export { markedTextHtml, typeInto, typeNode } from './typing';
export type { TypeIntoOptions, TypeNodeOptions } from './typing';

export { fadeInCenter, fadeOutAudio } from './fade';
export type { FadeInCenterOptions } from './fade';

export { srcMark } from './srcmark';
export type { SrcMarkHandle, SrcMarkHost } from './srcmark';
