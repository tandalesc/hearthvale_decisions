// The loading screen: from choosing to play until the town's first drawn frame.
// Its markup, style and first state live in index.html, so it is in the page's
// first paint, before any of the game's script has loaded. This only moves it
// through the real boot phases (main.js) and takes it away on the renderer's
// first-frame signal. It runs no timer or frame loop of its own: the only motion
// is CSS, which the compositor keeps running while the main thread is busy.
//
//   const loading = createLoading();
//   loading.phase('land');            // one of PHASES, as main.js reaches it
//   loading.name('Millbrook');        // the town's name, once known
//   loading.founding();               // the town is a new one
//   loading.toMenu();                 // the splash gives way to the main menu
//   loading.show({name, founding});   // a town was chosen on the menu
//   loading.pause();                  // that choice failed: the menu again
//   loading.done();                   // the town is drawn: fade out (at once under reduced motion)
//   loading.hide();                   // gone at once (a failure handed to a notice)

export const PHASES = [
  {id: 'code', label: 'Unfolding the map'},
  {id: 'chronicle', label: 'Reading the chronicle', founding: 'Founding the town'},
  {id: 'land', label: 'Raising the land'},
  {id: 'town', label: 'Building the town'},
  {id: 'lamps', label: 'Lighting the lamps'},
];
const FADE_MS = 400;

/**
 * Resolves once the page has painted. Before a long synchronous step (building the
 * land), so the phase it is in is on screen while it runs: a frame at most. A page
 * that draws no frames (hidden, throttled) waits 100 ms at most.
 */
export function painted() {
  if (document.visibilityState === 'hidden') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 100);
    requestAnimationFrame(() => setTimeout(() => { clearTimeout(timer); resolve(); }, 0));
  });
}

export function createLoading() {
  const root = document.getElementById('boot');
  let gone = !root;
  if (gone) return {active: false, phase() {}, founding() {}, name() {}, toMenu() {}, show() {}, pause() {}, done() {}, hide() {}};
  const steps = [...root.querySelectorAll('.boot-steps i')];
  const line = root.querySelector('.boot-phase');
  const title = root.querySelector('.boot-name');
  let at = 0;
  // The app's Motion setting (on <html> since index.html) or the system's.
  const reduced = () => document.documentElement.dataset.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches;

  function draw() {
    steps.forEach((el, i) => { el.className = i < at ? 'done' : i === at ? 'now' : ''; });
    const p = PHASES[at];
    line.textContent = `${(root.dataset.founding === '1' && p.founding) || p.label}…`;
  }
  function remove() {
    gone = true;
    root.remove();
  }
  draw();
  return {
    /** Still on screen (or waiting under the menu). */
    get active() { return !gone; },
    /** Moves on to a phase (never back): the steps before it are done. */
    phase(id) {
      const i = PHASES.findIndex((p) => p.id === id);
      if (gone || i <= at) return;
      performance.mark?.(`boot:${id}`);
      at = i;
      draw();
    },
    /** A new town is being founded (not a saved one read). */
    founding() {
      if (gone) return;
      root.dataset.founding = '1';
      draw();
    },
    name(text) {
      if (gone || !text || text === 'Hearthvale') return;
      title.textContent = text;
      root.dataset.named = '1';
    },
    /** The splash before the menu: fades out over the menu. */
    toMenu() {
      if (gone) return;
      const off = () => {
        if (root.dataset.mode !== 'splash') return; // a town was chosen meanwhile
        root.dataset.mode = 'off';
        root.classList.remove('boot-out');
      };
      if (reduced()) return off();
      root.classList.add('boot-out');
      setTimeout(off, FADE_MS + 50);
    },
    /** The phases: a town was chosen on the menu (fading in over it), or no menu came. */
    show({name, founding, fade = true} = {}) {
      if (gone) return;
      root.classList.remove('boot-out');
      if (founding != null) root.dataset.founding = founding ? '1' : '';
      if (name) this.name(name);
      if (root.dataset.mode !== 'load') {
        root.toggleAttribute('data-entering', fade);
        root.dataset.mode = 'load';
      }
      draw();
    },
    /** The choice failed: back to the menu (which says why). */
    pause() {
      if (gone) return;
      root.dataset.mode = 'off';
      root.dataset.named = '';
      title.textContent = 'Hearthvale';
    },
    /** The town is drawn: fade out over it. */
    done() {
      if (gone) return;
      performance.mark?.('boot:drawn');
      if (reduced()) return remove();
      gone = true;
      root.classList.add('boot-out');
      setTimeout(() => root.remove(), FADE_MS + 50);
    },
    hide: remove,
  };
}
