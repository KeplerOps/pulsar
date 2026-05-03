// Workbench entry — parses URL navigation parameters at runtime startup
// per ADR-007 ("the runtime parses URL parameters at startup") and
// activates PUL-F008's `scene` URL parameter contract.
//
// The lifecycle adapters (asset preloader factory, timeline runner)
// and the rest of the workbench mount land with PUL-A008's mode
// dispatch; until then, scene targets resolve against the (currently
// empty) registry and the resolved id is recorded on the `#stage`
// element via `data-pulsar-scene-target` so reviewers can verify the
// runtime parsed the URL. Parse / lookup errors are surfaced to the
// console so invalid URLs fail loudly per ADR-013's
// "no silent fallback" principle.

import { createSceneRegistry } from './runtime/registry';
import { resolveSceneNavigationTarget } from './runtime/url-navigation';

const stage = document.querySelector('#stage');
stage?.setAttribute('data-pulsar', 'placeholder');

// Empty until scene modules register in future requirements; the
// runtime still parses the URL on every startup so an invalid `scene`
// parameter surfaces immediately.
const registry = createSceneRegistry([]);

try {
  const target = resolveSceneNavigationTarget(window.location, registry);
  if (target !== null) {
    stage?.setAttribute('data-pulsar-scene-target', target.scene.id);
  }
} catch (err) {
  // Surface URL parse / lookup errors so reviewers and agents notice
  // malformed, repeated, or unknown `scene` values rather than landing
  // on a silently-default-rendered stage.
  console.error(err);
}
