// Workbench entry. The runtime mount lands once the scene contract
// (PUL-F001) and the workbench mode dispatch (PUL-A008) are in place.
// Until then this file marks the #stage element so the bundle has a
// non-trivial entry to build.
const stage = document.querySelector('#stage');
stage?.setAttribute('data-pulsar', 'placeholder');
