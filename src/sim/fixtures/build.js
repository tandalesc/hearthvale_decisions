// Regenerate the cached fixtures: node src/sim/fixtures/build.js [city]
import {writeFileSync} from 'node:fs';
import {growFixture, fixtureText, FIXTURE_PROFILES} from '../fixtures.js';

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(FIXTURE_PROFILES).filter((n) => FIXTURE_PROFILES[n].cached);
for (const name of names) {
  const t0 = performance.now();
  const state = growFixture(name, {
    onYear: (s) => {
      if (s.time.year % 10 === 0) console.log(`${name}: year ${s.time.year}, era ${s.era}, ${s.indicators.pop} people, ${s.buildings.length} buildings`);
    },
  });
  const text = fixtureText(state);
  writeFileSync(new URL(`./${name}.json`, import.meta.url), text);
  const bodies = state.institutions.filter((i) => i.status === 'active').map((i) => i.kind).join(', ');
  console.log(`${name}: done in ${((performance.now() - t0) / 1000).toFixed(1)} s. Year ${state.time.year}, era ${state.era}, ` +
    `${state.indicators.pop} people, ${state.buildings.length} buildings, archetype ${state.archetype}, bodies: ${bodies}, ` +
    `${state.docket.length} cards, ${(text.length / 1024).toFixed(0)} KB`);
}
