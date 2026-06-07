// Pulsar L2 chrome — public surface.
//
// Decks and templates import slot refs + effect helpers from here.
// CSS lives in `./atmospheric.css` and `./chrome.css` — `src/main.ts`
// imports both at bootstrap.

export { disposeChromeSlots, mountChromeSlots } from './slots';
export type { ChromeSlots, MountChromeSlotsHost } from './slots';

export {
  clearAct,
  clearBrand,
  clearTag,
  clearTitle,
  fadeOutAll,
  fireScreenFlash,
  flickerOutAll,
  renderAct,
  resetFlickers,
  setTag,
  shake,
  slamBrand,
  slamBrandClean,
  slamTitle,
} from './effects';

export { startClock } from './clock';
export type { ClockHandle, ClockHost } from './clock';

export { firePopout } from './popout';
export type { PopoutHost } from './popout';

export { createCounter, formatHms } from './counter';
export type { CounterHandle, CounterHost } from './counter';
