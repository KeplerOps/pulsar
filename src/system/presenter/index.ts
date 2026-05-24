// Pulsar L2 presenter — public surface.

export {
  createKeyboardPresenterSource,
  DEFAULT_KEYBOARD_BINDINGS,
} from './keyboard-source';
export type {
  KeyboardPresenterBindings,
  KeyboardPresenterHandle,
  KeyboardPresenterOptions,
} from './keyboard-source';

export { createPracticeRenderer, splitCaptionText } from './practice-renderer';
export type { PracticeRendererHandle, PracticeRendererHost } from './practice-renderer';

export { createChromePrompterRenderer, openPrompterWindow } from './prompter-window';
export type { PrompterWindowOptions } from './prompter-window';

export {
  combinePresenterSources,
  createPresenterBridge,
  DEFAULT_PRESENTER_CHANNEL,
  getPresenterSessionId,
  isPresenterSessionId,
  PRESENTER_SESSION_QUERY_PARAM,
  presenterChannelName,
} from './bridge';
export type { PresenterBridgeHandle, PresenterBridgeOptions } from './bridge';
