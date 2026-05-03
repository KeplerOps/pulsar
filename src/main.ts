// Workbench entry. PUL-F007 wires the URL navigation grammar parser
// into the browser runtime so parameter combinations are parsed at
// startup and on `popstate`. The full workbench bootstrap (scene
// registration per PUL-F001, mode dispatch per PUL-A008, composition
// orchestration) consumes the `'pulsar:navigate'` /
// `'pulsar:navigate-error'` events emitted by `bootstrapNavigation`
// once those requirements land.
import { bootstrapNavigation } from './runtime/navigation';

const stage = document.querySelector('#stage');
stage?.setAttribute('data-pulsar', 'placeholder');

bootstrapNavigation(window);
