// Bodies (institutions): who they are, when they form, what they track, what
// they draft, and how their power and patience rise and fall (design-systems §3).
//
// A body record in state.institutions:
//   {id, kind, name, foundedYear, status: 'active'|'waning'|'dissolved',
//    budgetShare, power, patience, metrics: {metricId: number[]}, lastProposalMonth,
//    delegated, delegateCap, standingOrders: [], accepted, refused, expired,
//    waningSince, declineSince, asker: {name, role}, funds, spentThisYear, report: []}
//
// Bodies petition to form through docket cards; the player rules. Drafting goes
// through the decision model (kind institution_draft); see decisions/scheduler.js.

import {holds, makeCtx, invalidateCtx} from './conditions.js';
import {rng, hash32} from './rng.js';
import {monthIndex} from './clock.js';
import {riverX} from '../terrain.js';
import {setTag} from './state.js';
import {delta} from './pressures.js';
import {POLICIES, CATEGORY_ERA, levelOf, canAdopt, againstGrain, upkeepFor, costScale, fiscalBase, detectTensions} from './policies.js';
import {fill, count, coin, LINES} from './text/voice.js';
import {addChronicle} from './chronicle.js';
import {factionGroup} from './factions.js';
import {addCard, cardsFrom, makeCard} from './docket.js';
import {candidateWorks as worldCandidates, bridgeCandidates as worldBridges} from './works.js';
import * as worksApi from './works.js';
import {payBuilders} from './economy.js';
import {templateSubjects, subjectBlocked, subjectInFlight} from './subjects.js';

const has = (id) => ['has', 'institution', id];

// sim-world's candidate works. A failure there must not stop the docket.
let warnedWorks = false;
// Kept in saved state (governance.worksCache) so a restored game sees the same list.
const worksCache = {
  get: (state) => state.governance?.worksCache ?? null,
  set: (state, value) => { if (state.governance) state.governance.worksCache = value; },
};
// Cached for half a year: a stale candidate is harmless, since startWork
// re-checks it ('gone') when the player rules.
const WORKS_FRESH_MONTHS = 6;
// The kinds of works the sitting bodies can draft.
const neededKinds = (state) => [...new Set(activeBodies(state).flatMap((b) => (INSTITUTIONS[b.kind]?.templates ?? []).map((t) => TEMPLATES[t]?.work).filter((k) => k && k !== 'bridge-basic')))].sort();

function worksTable(state) {
  const cached = worksCache.get(state);
  if (cached?.kinds) return cached;
  const table = {kinds: {}};
  worksCache.set(state, table);
  return table;
}

const stale = (state, entry) => !entry || monthIndex(state.time) - entry.month >= WORKS_FRESH_MONTHS;

function fetchKind(state, kind) {
  try {
    const list = worldCandidates(state, [kind]) ?? [];
    worksTable(state).kinds[kind] = {month: monthIndex(state.time), list};
    return list;
  } catch (err) {
    if (!warnedWorks && typeof console !== 'undefined') console.warn('[governance] candidate works failed:', err?.message);
    warnedWorks = true;
    worksTable(state).kinds[kind] = {month: monthIndex(state.time), list: []};
    return [];
  }
}

export const worksFresh = (state) => neededKinds(state).every((k) => !stale(state, worksTable(state).kinds[k]));

// Refresh the stalest needed kind (one sim-world call). Returns true if it did.
export function refreshWorks(state) {
  const table = worksTable(state);
  const due = neededKinds(state).filter((k) => stale(state, table.kinds[k]))
    .sort((a, b) => (table.kinds[a]?.month ?? -1) - (table.kinds[b]?.month ?? -1) || a.localeCompare(b));
  if (!due.length) return false;
  fetchKind(state, due[0]);
  return true;
}

export const draftsWorks = (body) => (INSTITUTIONS[body?.kind]?.templates ?? []).some((t) => TEMPLATES[t]?.work && TEMPLATES[t].work !== 'bridge-basic');

// Every cached candidate; a needed kind never fetched is fetched now.
export function candidateWorks(state) {
  const table = worksTable(state);
  const out = [];
  for (const kind of neededKinds(state)) out.push(...(table.kinds[kind]?.list ?? fetchKind(state, kind)));
  return out;
}
const notRefused = (id) => ['notag', `refused:${id}`, 15];

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export const INSTITUTIONS = {
  moot: {
    name: 'Village Moot', icon: 'hall', axis: {},
    color: '#7a5c3a', seat: ['moot'],
    names: [[0, 'Village Moot'], [2, 'Town Council'], [4, 'City Council']],
    asker: {role: 'steward', traits: ['careful', 'fair-minded']},
    explainer: 'The Moot is where the town meets. It brings you general plans.',
    metrics: ['coin', 'people', 'wellbeing', 'rules'],
    templates: ['fair', 'grade-track', 'hall-upgrade', 'ease-rule', 'emergency-loan', 'new-fields', 'cooperative', 'cart-bridge', 'bridge', 'bridge-upgrade', 'tax-cut', 'public-works'],
  },
  'agri-council': {
    name: 'Agricultural Council', icon: 'wheat', axis: {industry: -1},
    color: '#8a9a3b', seat: ['warehouse', 'farm'],
    constituency: {trades: ['farm']}, faction: 'farmers',
    when: ['soft', 0.6,
      [2, ['gte', 'C.farm', 4]],
      [3, ['gte', 'C.rulesLandFood', 2]],
      [1, ['lte', 'T.industry', 0.1]],
      [1, ['lte', 'I.foodBalance', 4]],
      [1, ['gte', 'C.farmShare', 0.3]]],
    chance: 0.25,
    declines: ['or', ['lt', 'C.farm', 4], ['gte', 'T.industry', 0.6]], declineYears: 5,
    rivals: ['trades-guild', 'planning'],
    asker: {role: 'farmer', traits: ['plain-spoken', 'stubborn']},
    petition: {
      title: 'A council for the farms',
      why: 'The farmers want their own council. It would track the harvest and bring you farm plans.',
    },
    explainer: 'The farmers watch the harvest here. They bring you plans for the fields.',
    metrics: ['farms', 'foodMonths', 'farmIncome', 'farmFamilies'],
    templates: ['seed-exchange', 'new-fields', 'tithe-barn', 'keep-old-fields'],
  },
  'trades-guild': {
    name: 'Craft Guild', icon: 'hammer', axis: {market: -0.5, innovation: -1},
    color: '#9a5b2e', seat: ['workshop'],
    constituency: {trades: ['craft']}, faction: 'crafters',
    when: ['and', ['gte', 'C.enterprises', 5], ['gte', 'T.market', -0.2],
      ['soft', 0.5, [2, ['gte', 'C.workshop', 2]], [1, ['era', 1]], [1, ['gte', 'I.pop', 150]], [2, ['gte', 'C.rulesCraft', 1]]]],
    chance: 0.2,
    declines: ['lt', 'C.enterprises', 3], declineYears: 5,
    rivals: ['exchange', 'union'],
    asker: {role: 'master smith', traits: ['proud', 'exacting']},
    petition: {
      title: 'A guild for the makers',
      why: 'The smiths and weavers want a guild. It would train apprentices and guard the quality of our goods.',
    },
    explainer: 'The makers of the town gather here. They guard their crafts and prices.',
    metrics: ['workshops', 'goods', 'craftFamilies', 'enterprises'],
    templates: ['guild-hall', 'quality-mark', 'keep-old-workshops'],
  },
  exchange: {
    name: 'Merchant Exchange', icon: 'scales', axis: {market: 1},
    color: '#c9a24a', seat: ['exchange', 'market'],
    constituency: {trades: ['trade', 'gentry']}, faction: 'merchants',
    when: ['soft', 0.6,
      [3, ['gte', 'T.market', 0.25]],
      [2, ['gte', 'P.riverTrade', 0.25]],
      [1, ['gte', 'I.pop', 400]],
      [2, ['gte', 'C.rulesTrade', 2]]],
    chance: 0.2,
    declines: ['lte', 'T.market', 0], declineYears: 6,
    rivals: ['trades-guild', 'union'],
    asker: {role: 'merchant', traits: ['quick', 'ambitious']},
    petition: {
      title: 'An exchange for the merchants',
      why: 'The merchants want a place to meet and strike deals. They say trade would double.',
    },
    explainer: 'The merchants meet here to trade. They push for open markets.',
    metrics: ['riverTrade', 'shops', 'merchantFamilies', 'avgWealth'],
    templates: ['exchange-hall', 'warehouses', 'redevelop-centre'],
  },
  'river-authority': {
    name: 'River Authority', icon: 'wave', axis: {},
    color: '#3f7a99', seat: ['quay', 'warehouse'],
    constituency: {trades: ['labour', 'trade'], nearRiver: true}, faction: 'labourers',
    when: ['or', ['gte', 'P.riverTrade', 0.25], ['tag', 'flood', 8], ['gte', 'C.crossings', 400],
      ['soft', 0.6, [3, ['gte', 'C.crossings', 200]], [2, ['gte', 'I.traffic', 0.3]], [1, ['era', 1]], [1, ['gte', 'I.pop', 200]]]],
    chance: 0.2,
    declines: ['and', ['lt', 'P.riverTrade', 0.1], ['notag', 'flood', 10]], declineYears: 10,
    rivals: ['agri-council', 'health-board'],
    asker: {role: 'boatwright', traits: ['practical', 'weathered']},
    petition: {
      title: 'Someone to mind the river',
      why: 'The river brings trade and floods. The boat folk want a body to manage both.',
    },
    explainer: 'The river folk meet here. They bring you bridges, quays and flood works.',
    metrics: ['riverTrade', 'bridges', 'crossings', 'floodRisk'],
    templates: ['bridge', 'bridge-upgrade', 'quay', 'embankment', 'ferry', 'dredging'],
  },
  'school-board': {
    name: 'School Board', icon: 'book', axis: {innovation: 1},
    color: '#5a6fa8', seat: ['school', 'library'],
    constituency: {trades: ['clerical']}, faction: 'scholars',
    when: ['soft', 0.6,
      [2, ['gte', 'I.pop', 200]],
      [2, ['gte', 'P.learning', 0.12]],
      [1, ['gte', 'T.innovation', 0.15]],
      [2, ['gte', 'C.rulesEducation', 1]],
      [1, ['era', 2]]],
    chance: 0.2,
    declines: ['lt', 'I.literacy', 0.2], declineYears: 15,
    rivals: ['parish', 'union'],
    asker: {role: 'schoolmistress', traits: ['patient', 'hopeful']},
    petition: {
      title: 'A board for our schools',
      why: 'Parents want their children to read. A school board would open schools and find teachers.',
    },
    explainer: 'The teachers and parents meet here. They bring you plans for schools.',
    metrics: ['literacy', 'schools', 'learning', 'scholarFamilies'],
    templates: ['school', 'scholarships'],
  },
  parish: {
    name: 'Chapel', icon: 'bell', axis: {innovation: -1},
    color: '#8a4f7d', seat: ['chapel'],
    names: [[0, 'Chapel'], [2, 'Church'], [4, 'Cathedral Chapter']],
    constituency: {trades: ['clergy'], faithBand: 2}, faction: 'clergy',
    when: ['soft', 0.6,
      [3, ['gte', 'P.faith', 0.28]],
      [2, ['or', ['has', 'policy', 'feast-days'], ['has', 'policy', 'fast-days']]],
      [1, ['era', 1]],
      [1, ['gte', 'C.chapel', 1]],
      [1, ['lte', 'I.tension', 0.15]]],
    chance: 0.2,
    declines: ['lt', 'P.faith', 0.15], declineYears: 10,
    rivals: ['school-board', 'exchange'],
    asker: {role: 'priest', traits: ['gentle', 'devout']},
    petition: {
      title: 'A chapel with a voice',
      why: 'The faithful want the chapel to have a say. It would keep the feasts and care for the poor.',
    },
    explainer: 'The faithful gather here. They keep the feasts and tend the poor.',
    metrics: ['faith', 'chapels', 'feasts', 'clergyFamilies'],
    templates: ['chapel-upgrade', 'alms-house'],
  },
  'health-board': {
    name: 'Health Board', icon: 'cross', axis: {},
    color: '#4f8a6a', seat: ['infirmary', 'bathhouse'],
    when: ['soft', 0.6,
      [2, ['gte', 'I.pop', 300]],
      [2, ['lte', 'P.health', 0.35]],
      [2, ['tag', 'plague', 10]],
      [2, ['gte', 'C.rulesHealth', 2]],
      [1, ['gte', 'I.density', 0.4]]],
    chance: 0.25,
    declines: ['and', ['gte', 'P.health', 0.75], ['notag', 'plague', 15]], declineYears: 15, declineSoft: true,
    rivals: ['trades-guild', 'exchange'],
    asker: {role: 'physician', traits: ['worried', 'precise']},
    petition: {
      title: 'A board to fight sickness',
      why: 'Too many people are sick. The healers want a board to dig wells and keep the streets clean.',
    },
    explainer: 'The healers meet here. They watch for sickness and bring you plans to stop it.',
    metrics: ['health', 'wellsLevel', 'infirmaries', 'sickness'],
    templates: ['infirmary-house', 'slum-clearance', 'bathhouse'],
  },
  planning: {
    name: 'Planning Office', icon: 'compass', axis: {authority: 1},
    color: '#6b6b6b', seat: ['moot'],
    when: ['or', ['and', ['gte', 'I.traffic', 0.4], ['era', 2]], ['gte', 'T.authority', 0.3],
      ['soft', 0.6, [2, ['gte', 'C.roads3', 40]], [2, ['era', 2]], [1, ['gte', 'C.rulesStreets', 1]], [1, ['gte', 'I.traffic', 0.25]]]],
    chance: 0.2,
    declines: ['lte', 'T.authority', -0.4], declineYears: 8,
    rivals: ['agri-council', 'exchange'],
    asker: {role: 'surveyor', traits: ['orderly', 'far-sighted']},
    petition: {
      title: 'A plan for the streets',
      why: 'The lanes are crowded and muddy. A planning office would pave the busy ones and plan new streets.',
    },
    explainer: 'The surveyors work here. They see where people walk and plan the streets.',
    metrics: ['roads', 'traffic', 'density', 'housing'],
    templates: ['pave-lane', 'square', 'widen', 'ring-road', 'grid', 'bridge', 'bridge-upgrade', 'redevelop-centre', 'turnpike'],
  },
  union: {
    name: "Workers' Union", icon: 'fist', axis: {market: -1},
    color: '#b04a3a', seat: ['union-hall'],
    constituency: {trades: ['labour'], maxWealthBand: 1}, faction: 'labourers',
    when: ['soft', 0.7,
      [2, ['gte', 'T.industry', 0.25]],
      [2, ['gte', 'I.inequality', 0.4]],
      [2, ['gte', 'C.bigEnterprises', 2]],
      [2, ['torn', 'react_to_policy', 'trade', 'wealthBand', 0.3, 40]],
      [1, ['gte', 'C.labourShare', 0.3]]],
    chance: 0.2,
    declines: ['lt', 'I.inequality', 0.25], declineYears: 10,
    rivals: ['exchange', 'trades-guild'],
    asker: {role: 'mill hand', traits: ['blunt', 'loyal']},
    petition: {
      title: 'The workers want a union',
      why: 'Mill hands work long days for little pay. They want a union to speak for them.',
    },
    explainer: 'The workers meet here. They fight for pay and shorter days.',
    metrics: ['wages', 'inequality', 'bigEmployers', 'labourFamilies'],
    templates: ['union-hall', 'sick-fund', 'call-strike'],
  },
  watch: {
    name: 'Town Watch', icon: 'lantern', axis: {authority: 1},
    color: '#3d4a5c', seat: ['watch'],
    when: ['or', ['gte', 'P.unrest', 0.3], ['gte', 'I.pop', 1000], ['gte', 'I.tension', 0.25],
      ['soft', 0.6, [2, ['gte', 'I.pop', 400]], [2, ['gte', 'P.unrest', 0.15]], [1, ['era', 2]]]],
    chance: 0.2,
    declines: ['lt', 'P.unrest', 0.1], declineYears: 10, declineSoft: true,
    rivals: ['union', 'parish'],
    asker: {role: 'watch captain', traits: ['stern', 'dutiful']},
    petition: {
      title: 'A watch for the streets',
      why: 'There is trouble after dark. Some want a town watch to keep the peace.',
    },
    explainer: 'The watch keeps the peace. It brings you plans for lamps and patrols.',
    metrics: ['unrest', 'watchHouses', 'lampsLevel', 'tension'],
    templates: ['watch-house', 'tavern-licences'],
  },
  // One per centre other than the seat: 'ward:<centreId>' (design-centres §4).
  ward: {
    name: 'Ward Council', icon: 'hall', axis: {authority: -0.5},
    color: '#7f6a4a', seat: ['moot', 'market'],
    rivals: ['ward'],
    asker: {role: 'alderman', traits: ['proud', 'local']},
    petition: {
      title: 'A council of our own',
      why: '{centre} has grown into a town of its own. Its people want their own council to look after local things.',
    },
    explainer: 'This ward runs its own corner of the valley. It brings you local plans.',
    metrics: ['wardPeople', 'wardJobs', 'wardAutonomy'],
    templates: ['ward-market', 'ward-school', 'ward-rates'],
  },
  'arts-society': {
    name: 'Festival Society', icon: 'mask', axis: {},
    color: '#c46a9a', seat: ['theatre', 'market'],
    when: ['soft', 0.7,
      [3, ['gte', 'P.prestige', 0.15]],
      [2, ['gte', 'I.avgWealth', 150]],
      [1, ['lte', 'I.tension', 0.15]],
      [1, ['gte', 'C.rulesFaith', 1]]],
    chance: 0.15,
    declines: ['lt', 'I.avgWealth', 100], declineYears: 6,
    rivals: ['parish', 'watch'],
    asker: {role: 'fiddler', traits: ['merry', 'restless']},
    petition: {
      title: 'A society for fairs and plays',
      why: 'People have coin to spare and time to enjoy it. A festival society would bring music and fairs.',
    },
    explainer: 'The players and musicians meet here. They bring fairs, plays and music.',
    metrics: ['prestige', 'fairs', 'theatres', 'avgWealth'],
    templates: ['fair', 'theatre', 'carnival'],
  },
};

for (const [id, def] of Object.entries(INSTITUTIONS)) {
  def.id = id;
  def.policies = Object.keys(POLICIES).filter((pid) => POLICIES[pid].by?.includes(id));
}

export const BODY_IDS = Object.keys(INSTITUTIONS);

// ---------------------------------------------------------------------------
// Dashboard metrics (max 6 per body, sampled quarterly, 60 points kept)
// ---------------------------------------------------------------------------

const ind = (s, k) => s.indicators?.[k] ?? 0;
const pr = (s, k) => s.pressures?.[k] ?? 0;
const pct = (x) => Math.round(x * 100);
const cnt = (s, k) => makeCtx(s).C[k] ?? 0;
const tradeFamilies = (s, trade) => s.households.reduce((n, h) => n + (h.trade === trade ? 1 : 0), 0);

export const METRICS = {
  coin: {label: 'Coin', unit: 'coin', read: (s) => Math.round(s.treasury ?? 0)},
  people: {label: 'People', unit: '', read: (s) => ind(s, 'pop') || s.households.reduce((n, h) => n + h.size, 0)},
  wellbeing: {label: 'Wellbeing', unit: '%', read: (s) => Math.round(ind(s, 'wellbeing'))},
  rules: {label: 'Rules in force', unit: '', read: (s) => cnt(s, 'policies')},
  farms: {label: 'Farms', unit: '', read: (s) => cnt(s, 'farm')},
  foodMonths: {label: 'Food stores', unit: 'months', read: (s) => Math.round(ind(s, 'foodBalance') * 10) / 10},
  farmIncome: {label: 'Farm income', unit: 'coin', read: (s) => Math.round(s.enterprises.filter((e) => e.type === 'farm').reduce((n, e) => n + (e.profitLastYear ?? 0), 0))},
  farmFamilies: {label: 'Farm families', unit: '', read: (s) => tradeFamilies(s, 'farm')},
  workshops: {label: 'Workshops', unit: '', read: (s) => cnt(s, 'workshop') + cnt(s, 'mill') + cnt(s, 'factory')},
  goods: {label: 'Goods in store', unit: '', read: (s) => Math.round(s.goods ?? 0)},
  craftFamilies: {label: 'Maker families', unit: '', read: (s) => tradeFamilies(s, 'craft')},
  enterprises: {label: 'Businesses', unit: '', read: (s) => s.enterprises.length},
  riverTrade: {label: 'River trade', unit: '%', read: (s) => pct(pr(s, 'riverTrade'))},
  shops: {label: 'Shops and stalls', unit: '', read: (s) => cnt(s, 'shop') + cnt(s, 'market')},
  merchantFamilies: {label: 'Merchant families', unit: '', read: (s) => tradeFamilies(s, 'trade')},
  avgWealth: {label: 'Average savings', unit: 'coin', read: (s) => Math.round(ind(s, 'avgWealth'))},
  bridges: {label: 'Bridges', unit: '', read: (s) => cnt(s, 'bridge')},
  crossings: {label: 'Crossings a year', unit: '', read: (s) => Object.values(s.roads?.xings ?? {}).reduce((a, b) => a + b, 0)},
  floodRisk: {label: 'Flood risk', unit: '%', read: (s) => pct(floodRisk(s))},
  literacy: {label: 'People who read', unit: '%', read: (s) => pct(ind(s, 'literacy'))},
  schools: {label: 'Schools', unit: '', read: (s) => cnt(s, 'school')},
  learning: {label: 'Learning', unit: '%', read: (s) => pct(pr(s, 'learning'))},
  scholarFamilies: {label: 'Clerk families', unit: '', read: (s) => tradeFamilies(s, 'clerical')},
  faith: {label: 'Faith', unit: '%', read: (s) => pct(pr(s, 'faith'))},
  chapels: {label: 'Chapels', unit: '', read: (s) => cnt(s, 'chapel')},
  feasts: {label: 'Feasts kept', unit: '', read: (s) => s.tagCounts?.['feast-day'] ?? 0},
  clergyFamilies: {label: 'Clergy families', unit: '', read: (s) => tradeFamilies(s, 'clergy')},
  health: {label: 'Health', unit: '%', read: (s) => pct(pr(s, 'health'))},
  wellsLevel: {label: 'Wells rule', unit: 'level', read: (s) => levelOf(s, 'wells')},
  infirmaries: {label: 'Infirmaries', unit: '', read: (s) => cnt(s, 'infirmary')},
  sickness: {label: 'Sickness', unit: '%', read: (s) => pct(1 - pr(s, 'health'))},
  roads: {label: 'Road cells', unit: '', read: (s) => cnt(s, 'roads3')},
  traffic: {label: 'Traffic', unit: '%', read: (s) => pct(Math.min(1, ind(s, 'traffic')))},
  density: {label: 'Crowding', unit: '%', read: (s) => pct(ind(s, 'density'))},
  housing: {label: 'Families waiting', unit: '%', read: (s) => pct(ind(s, 'housingPressure'))},
  wages: {label: 'Day wage', unit: 'coin', read: (s) => Math.round((s.economy?.wageRate ?? 10) * 10) / 10},
  inequality: {label: 'Rich and poor gap', unit: '%', read: (s) => pct(ind(s, 'inequality'))},
  bigEmployers: {label: 'Big employers', unit: '', read: (s) => cnt(s, 'bigEnterprises')},
  labourFamilies: {label: 'Labour families', unit: '', read: (s) => tradeFamilies(s, 'labour')},
  unrest: {label: 'Unrest', unit: '%', read: (s) => pct(pr(s, 'unrest'))},
  watchHouses: {label: 'Watch houses', unit: '', read: (s) => cnt(s, 'watch')},
  lampsLevel: {label: 'Lamps rule', unit: 'level', read: (s) => levelOf(s, 'lamps')},
  tension: {label: 'Divided streets', unit: '%', read: (s) => pct(ind(s, 'tension'))},
  prestige: {label: 'Fame', unit: '%', read: (s) => pct(pr(s, 'prestige'))},
  fairs: {label: 'Fairs held', unit: '', read: (s) => s.tagCounts?.fair ?? 0},
  wardPeople: {label: 'People', unit: '', read: (s, b) => wardCentre(s, b)?.monthly?.pop ?? wardCentre(s, b)?.pop ?? 0},
  wardJobs: {label: 'Jobs', unit: '', read: (s, b) => wardCentre(s, b)?.monthly?.jobs ?? wardCentre(s, b)?.jobs ?? 0},
  wardAutonomy: {label: 'Say of its own', unit: '%', read: (s, b) => Math.round((wardCentre(s, b)?.autonomy ?? 0) * 100)},
  theatres: {label: 'Theatres', unit: '', read: (s) => cnt(s, 'theatre')},
};

const wardCentre = (state, body) => (state.centres ?? []).find((c) => c.id === body?.centreId) ?? null;

export function floodRisk(state) {
  const eco = pr(state, 'ecology');
  const protect = levelOf(state, 'riverbank-protect');
  return Math.max(0, Math.min(1, (1 - eco) * 1.5 + 0.15 - protect * 0.12));
}

// ---------------------------------------------------------------------------
// Proposal templates (beyond the rules a body may draft)
//
// need(state, body) -> 0..1 urgency. cost: era-0 coin (era-scaled at draft).
// options: [{key, label, tradeoff, effects: [...]}]; the docket adds Not now / Refuse.
// Effects: {policy, level|'+1'|'-1'}, {build, variant}, {work}, {deltas}, {tag},
// {spend: 'cost'|n}, {budget}, {event}, {patience}, {loan}.
// ---------------------------------------------------------------------------

const ramp = (v, lo, hi) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)));

export const UPGRADE_MIN_AGE = 15;

export const TEMPLATES = {
  fair: {
    title: 'A summer fair', category: 'faith', cost: 250,
    helps: ['trade', 'labour'], hurts: ['clergy'],
    why: 'Summer is coming. A fair would bring traders and lift spirits.',
    when: ['or', ['has', 'policy', 'market-charter'], has('arts-society'), ['gte', 'I.pop', 60]],
    need: (s) => 0.25 + 0.4 * ramp(pr(s, 'unrest'), 0.1, 0.4) + 0.2 * ramp(ind(s, 'avgWealth'), 80, 200),
    options: [
      {key: 'do', label: 'Fund a fine fair', tradeoff: 'Visitors come and spend. It costs {cost}.',
        effects: [{spend: 'cost'}, {event: 'fair', choice: 'fund'}]},
      {key: 'small', label: 'A simple fair', tradeoff: 'No cost to the town. A smaller crowd.',
        effects: [{event: 'fair', choice: 'allow'}]},
    ],
  },
  // When the chest is full, the Moot offers to give some back or put it to work.
  'tax-cut': {
    title: 'Lower the taxes', category: 'tax', cost: 0,
    helps: ['labour', 'trade', 'gentry'], hurts: [],
    why: 'The town chest is full. Families ask why they still pay so much.',
    when: ['and', ['gte', 'I.treasuryYears', 5], ['or', ['has', 'policy', 'property-tax'], ['has', 'policy', 'income-tax']]],
    need: (s) => 0.35 + 0.5 * ramp(ind(s, 'treasuryYears'), 5, 10),
    options: [
      {key: 'do', label: 'Lower the property tax', tradeoff: 'Every home keeps more. The chest fills more slowly.', effects: [{policy: 'property-tax', level: '-1'}],
        when: (s) => canCut(s, 'property-tax')},
      {key: 'income', label: 'Lower the income tax', tradeoff: 'Workers keep more of their pay. The chest fills more slowly.', effects: [{policy: 'income-tax', level: '-1'}],
        when: (s) => canCut(s, 'income-tax')},
    ],
  },
  'public-works': {
    title: 'A year of public works', category: 'infrastructure', cost: 900,
    // A quarter of what lies in the chest beyond two years of spending.
    costFn: (s) => Math.max(Math.round(900 * costScale(s)), Math.round(0.25 * ((s.treasury ?? 0) - 2 * (s.economy?.lastYear?.treasurySpend ?? 0)))),
    helps: ['labour', 'craft'], hurts: [],
    why: 'Coin sits idle in the chest. It could mend walls, clear drains and plant trees.',
    when: ['gte', 'I.treasuryYears', 4],
    need: (s) => 0.3 + 0.5 * ramp(ind(s, 'treasuryYears'), 4, 10),
    options: [
      {key: 'do', label: 'Put the coin to work', tradeoff: 'It costs {cost}. Builders are busy and the town looks after itself.',
        effects: [{spend: 'cost', local: true}, {tag: 'public-works'}, {deltas: {prestige: 0.02, health: 0.02, unrest: -0.03}}]},
    ],
  },
  cooperative: {
    title: 'A town cooperative', category: 'civic', cost: 200,
    helps: ['labour', 'farm'], hurts: ['gentry', 'trade'],
    why: 'Families want to share tools, carts and a common store. They ask the town to start them off.',
    when: ['and', ['lte', 'T.market', 0], ['notag', 'cooperative', 20]],
    need: (s) => 0.25 + 0.4 * ramp(-s.traits.market, 0, 0.5),
    options: [
      {key: 'do', label: 'Back the cooperative', tradeoff: 'It costs {cost}. Neighbours share more and compete less.',
        effects: [{spend: 'cost'}, {tag: 'cooperative'}, {deltas: {market: -0.04, unrest: -0.02, authority: -0.01}}]},
    ],
  },
  'emergency-loan': {
    title: 'A loan from the valley bank', category: 'tax', cost: 0,
    helps: [], hurts: [],
    why: 'Our coin is nearly gone. The valley bank will lend, at a price.',
    when: ['and', ['lte', 'I.treasuryYears', 0.3], ['lt', 'C.coin', 0]],
    need: (s) => 0.9 * ramp(0.3 - ind(s, 'treasuryYears'), 0, 0.3),
    options: [
      {key: 'do', label: 'Borrow a little', tradeoff: 'Coin now. We repay with interest for years.',
        effects: [{loan: 600}]},
      {key: 'more', label: 'Borrow a lot', tradeoff: 'Plenty of coin now. A heavy debt later.',
        effects: [{loan: 1600}]},
    ],
  },
  'hall-upgrade': {
    title: 'A proper town hall', category: 'civic', cost: 1800,
    helps: ['clerical'], hurts: [],
    why: 'The moot hall is too small for the town we have become.',
    when: ['and', ['era', 2], ['notag', 'town-hall']],
    need: (s) => 0.2 + 0.1 * (s.era ?? 0),
    options: [
      {key: 'do', label: 'Build a town hall', tradeoff: 'It costs {cost}. The town gains a fine centre.',
        effects: [{spend: 'cost'}, {build: 'moot', variant: 'town-hall'}, {tag: 'town-hall'}, {deltas: {prestige: 0.03, authority: 0.02}}]},
    ],
  },
  'ease-rule': {
    title: 'Ease a rule', category: 'civic', cost: 0, dynamic: 'ease',
    helps: [], hurts: [],
    why: 'The rule on {rule} costs more than it gives. The town would breathe easier without it.',
    when: true,
    need: () => 0,
    options: [
      {key: 'do', label: 'Soften it', tradeoff: 'Less upkeep and grumbling. Its effect weakens.', effects: [{policy: 'target', level: '-1'}]},
      {key: 'more', label: 'Repeal it', tradeoff: 'The rule is gone. So is what it did.', effects: [{policy: 'target', level: 0}]},
    ],
  },
  // Before era 2 a busy track can only be graded to gravel, and only when it is
  // actually churned to mud (spring or rain). The Moot raises it, rarely.
  'grade-track': {
    title: 'Grade the busy track', category: 'infrastructure', work: 'pave', workFilter: (w) => w.tier === 3,
    helps: ['trade', 'farm'], hurts: [],
    why: 'The track {place} is churned to mud. Gravel would keep carts moving.',
    when: ['and', ['era', 1], ['not', ['era', 2]], ['gte', 'C.muddy', 1]],
    need: (s, body, w) => 0.5 * workPressure(w),
    options: [
      {key: 'do', label: 'Grade it with gravel', tradeoff: 'It costs {cost}. The track stays firm in the wet.', effects: [{work: true, variant: 'all'}]},
      {key: 'half', label: 'Grade the worst part', tradeoff: 'Half the cost. The rest stays rutted.', effects: [{work: true, variant: 'half'}]},
    ],
  },
  // Paving (cobbles, tier 4) is the Planning Office's, from era 2.
  'pave-lane': {
    title: 'Pave the busiest lane', category: 'infrastructure', work: 'pave', workFilter: (w) => w.tier === 4,
    helps: ['trade'], hurts: [],
    why: 'The lane {place} turns to mud each spring. Carts get stuck there every week.',
    when: ['era', 2],
    need: (s, body, w) => 0.2 + 0.6 * workPressure(w),
    options: [
      {key: 'do', label: 'Pave it all', tradeoff: 'It costs {cost}. Carts move quicker for years.', effects: [{work: true, variant: 'all'}]},
      {key: 'half', label: 'Pave the worst half', tradeoff: 'Half the cost. The rest stays muddy.', effects: [{work: true, variant: 'half'}]},
    ],
  },
  square: {
    title: 'A square for the town', category: 'infrastructure', work: 'square',
    helps: ['trade', 'gentry'], hurts: [],
    why: 'Many streets meet {place}. A paved square would give the town a heart.',
    when: ['era', 2],
    need: (s) => 0.25 + 0.3 * ramp(pr(s, 'prestige'), 0.1, 0.5),
    options: [
      {key: 'do', label: 'Lay out the square', tradeoff: 'It costs {cost}. Land nearby gains value.', effects: [{work: true}]},
    ],
  },
  widen: {
    title: 'Widen the main street', category: 'infrastructure', work: 'widen',
    helps: ['trade'], hurts: ['labour'],
    why: 'The main street is jammed from dawn to dusk. {homes} homes would have to move.',
    when: ['era', 3],
    need: (s) => 0.2 + 0.5 * ramp(ind(s, 'traffic'), 0.5, 1),
    options: [
      {key: 'do', label: 'Make it an avenue', tradeoff: 'It costs {cost}. The town pays the families who move.', effects: [{work: true}]},
    ],
  },
  'ring-road': {
    title: 'A road around the centre', category: 'infrastructure', work: 'ring',
    helps: ['trade'], hurts: ['farm'],
    why: 'Carts crowd the centre on their way through. A ring road would take them around.',
    when: ['and', ['era', 3], ['gte', 'I.traffic', 0.6]],
    need: (s) => 0.4 * ramp(ind(s, 'traffic'), 0.6, 1),
    options: [
      {key: 'do', label: 'Build the ring road', tradeoff: 'It costs {cost}. The centre grows quieter.', effects: [{work: true}]},
    ],
  },
  grid: {
    title: 'Plan the new quarter', category: 'infrastructure', work: 'grid',
    helps: ['labour'], hurts: ['gentry'],
    why: 'Newcomers are settling {place}. Streets laid out now would keep it tidy.',
    when: ['era', 2],
    need: (s) => 0.3 + 0.4 * ramp(ind(s, 'housingPressure'), 0.2, 0.6),
    options: [
      {key: 'do', label: 'Lay out a grid', tradeoff: 'It costs {cost}. Straight streets, planned lots.', effects: [{work: true, variant: 'plan'}, {deltas: {authority: 0.02}}]},
    ],
  },
  // A bridge that is worn or too small for its traffic (sim-world's
  // bridgeUpgradeCandidates). Comes back sooner if the load keeps rising.
  'bridge-upgrade': {
    title: 'The bridge needs work', category: 'infrastructure', work: 'bridge-upgrade', returnsOnDemand: true, returnFactor: 1.25,
    // A bridge is not rebuilt within fifteen years of opening, however busy; a worn one may be mended any time.
    workFilter: (w) => (w.condition ?? 1) <= 0.35 || (w.age ?? 0) >= UPGRADE_MIN_AGE,
    helps: ['trade', 'labour'], hurts: [],
    why: 'The bridge {place} is {state}. Carts queue at both ends.',
    when: true,
    need: (s, body, w) => 0.15 + 0.6 * Math.max(ramp(bridgeLoad(w), 0.8, 1.6), ramp(1 - (w?.condition ?? 1), 0.3, 0.8)),
    options: [
      {key: 'stone', label: 'Rebuild in stone', tradeoff: 'It costs {cost}. It will carry the town for a century.', era: 2, effects: [{work: true, variant: 'stone'}, {deltas: {prestige: 0.01}}]},
      {key: 'iron', label: 'Rebuild in iron', tradeoff: 'It costs {cost}. A wide, modern span.', era: 4, effects: [{work: true, variant: 'iron'}, {deltas: {prestige: 0.02, innovation: 0.01}}]},
      {key: 'widen', label: 'Widen it in timber', tradeoff: 'It costs {cost}. More carts can cross at once.', effects: [{work: true, variant: 'widen'}]},
      {key: 'repair', label: 'Repair it', tradeoff: 'It costs {cost}. It is sound again, but no wider.', effects: [{work: true, variant: 'repair'}]},
    ],
  },
  // A basic timber cart bridge, for a village whose people already wade a ford.
  // A possibility, not a push: offered whenever sim-world sees a basic crossing,
  // keenly only when many people cross. After Not now it waits for demand to double.
  'cart-bridge': {
    title: 'A cart bridge at the ford', category: 'infrastructure', work: 'bridge-basic', returnsOnDemand: true,
    helps: ['trade', 'farm', 'labour'], hurts: [],
    why: 'Folk wade the river {place} every day. A plain timber bridge would carry their carts.',
    when: true,
    need: (s, body, w) => 0.1 + 0.5 * ramp(bridgeDemand(w), 1, 3),
    options: [
      {key: 'do', label: 'Build in timber', tradeoff: 'It costs {cost}. Carts can cross in any weather.', effects: [{spend: 'cost'}, {work: true, variant: 'timber', paid: true}, {deltas: {riverTrade: 0.02}}]},
      {key: 'planks', label: 'Let folk keep the planks', tradeoff: 'No cost. People lay planks across as they always have.', effects: [{tag: 'planks'}]},
    ],
  },
  bridge: {
    title: 'A bridge at the ford', category: 'infrastructure', work: 'bridge', salient: true,
    helps: ['trade', 'labour'], hurts: [],
    why: 'Many people cross {place}. In spring it floods. A bridge would save time and lives.',
    when: true,
    need: (s) => 0.55 + 0.35 * ramp(Object.values(s.roads?.xings ?? {}).reduce((a, b) => Math.max(a, b), 0), 400, 1200),
    options: [
      {key: 'do', label: 'Build in timber', tradeoff: 'Cheap. It will need replacing in sixty years.', effects: [{work: true, variant: 'timber'}, {deltas: {riverTrade: 0.03}}]},
      {key: 'stone', label: 'Build in stone', tradeoff: 'Three times the cost. It lasts and looks fine.', effects: [{work: true, variant: 'stone'}, {deltas: {prestige: 0.02, riverTrade: 0.04}}]},
      {key: 'ferry', label: 'License a ferry', tradeoff: 'No cost. Slower, and the ferryman takes a fee.', effects: [{work: true, variant: 'ferry'}, {deltas: {riverTrade: 0.01}}]},
    ],
  },
  quay: {
    title: 'A stone quay', category: 'infrastructure', work: 'quay',
    helps: ['trade', 'labour'], hurts: [],
    why: 'Boats tie up in the mud {place}. A quay would let them load in any weather.',
    when: ['gte', 'P.riverTrade', 0.2],
    need: (s) => 0.2 + 0.6 * ramp(pr(s, 'riverTrade'), 0.2, 0.6),
    options: [
      {key: 'do', label: 'Build the quay', tradeoff: 'It costs {cost}. More boats will stop here.', effects: [{work: true}, {deltas: {riverTrade: 0.03}}]},
    ],
  },
  embankment: {
    title: 'A wall against the floods', category: 'environment', work: 'embankment',
    helps: ['farm', 'labour'], hurts: [],
    why: 'The river spills over {place} most springs. A stone bank would hold it.',
    when: ['or', ['tag', 'flood', 15], ['gte', 'P.riverTrade', 0.2]],
    need: (s) => 0.3 + 0.5 * ramp(floodRisk(s), 0.2, 0.6),
    options: [
      {key: 'do', label: 'Build the embankment', tradeoff: 'It costs {cost}. Floods do far less harm.', effects: [{work: true, variant: 'stone'}]},
    ],
  },
  turnpike: {
    title: 'A turnpike between the towns', category: 'infrastructure', work: 'turnpike',
    helps: ['trade'], hurts: ['farm'],
    why: 'Carts crawl along the old road {place}. A proper turnpike would join the towns.',
    when: ['era', 2],
    need: () => 0.45,
    options: [
      {key: 'do', label: 'Build the turnpike', tradeoff: 'It costs {cost}. Trade between the towns quickens.', effects: [{work: true, variant: 'build'}, {deltas: {market: 0.01}}]},
    ],
  },
  'ward-market': {
    title: 'A market charter for the ward', category: 'trade', cost: 120,
    helps: ['trade'], hurts: [],
    why: 'Folk in {centre} walk all the way to the old market. They want a market day of their own.',
    when: ['notag', 'ward-market:{centreId}'],
    need: () => 0.45,
    options: [
      {key: 'do', label: 'Grant the charter', tradeoff: 'It costs {cost}. {centre} grows more of its own.', effects: [{spend: 'cost'}, {tag: 'ward-market:{centreId}'}, {build: 'market', at: 'centre'}]},
    ],
  },
  'ward-school': {
    title: 'A school for the ward', category: 'education', cost: 700,
    helps: ['clerical', 'labour'], hurts: [],
    why: 'Children in {centre} walk a long way to school. The ward wants one close by.',
    when: ['era', 2],
    need: () => 0.4,
    options: [
      {key: 'do', label: 'Build it in the ward', tradeoff: 'It costs {cost}. Learning grows in {centre}.', effects: [{spend: 'cost'}, {build: 'school', at: 'centre'}, {deltas: {learning: 0.01}}]},
    ],
  },
  'ward-rates': {
    title: 'The ward keeps its own rates', category: 'tax', cost: 0,
    helps: [], hurts: ['gentry'],
    why: '{centre} says its taxes are spent on the old town. It wants to keep a share for itself.',
    when: ['notag', 'ward-rates:{centreId}'],
    need: () => 0.35,
    options: [
      {key: 'do', label: 'Let it keep a share', tradeoff: 'The ward grows bolder. The town purse shrinks a little.', effects: [{tag: 'ward-rates:{centreId}'}, {budget: 0.03}]},
    ],
  },
  ferry: {
    title: 'A ferry licence', category: 'infrastructure', cost: 0,
    helps: ['trade'], hurts: [],
    why: 'A boatman offers to run a ferry. He would pay us for the right.',
    when: ['and', ['lt', 'C.bridge', 1], ['notag', 'ferry', 20]],
    need: () => 0.35,
    options: [
      {key: 'do', label: 'Grant the licence', tradeoff: 'No cost. Trade crosses the river more easily.', effects: [{deltas: {riverTrade: 0.01}}, {tag: 'ferry'}]},
    ],
  },
  dredging: {
    title: 'Dredge the channel', category: 'environment', cost: 500,
    helps: ['trade'], hurts: ['farm'],
    why: 'Silt is choking the channel. Big boats scrape the bottom.',
    when: ['gte', 'P.riverTrade', 0.3],
    need: (s) => 0.3 * ramp(pr(s, 'riverTrade'), 0.3, 0.7),
    options: [
      {key: 'do', label: 'Dredge it', tradeoff: 'It costs {cost}. Bigger boats can come.', effects: [{spend: 'cost'}, {deltas: {riverTrade: 0.03, ecology: -0.01}}]},
    ],
  },
  // Displacement: old trades want to stay; merchants and planners want the centre put to use.
  'keep-old-fields': {
    title: 'Keep the old fields', category: 'land', cost: 0,
    helps: ['farm'], hurts: ['gentry', 'trade'],
    why: 'Farms near the centre are being sold for houses. The farmers want the town to slow it down.',
    when: ['or', ['tag', 'farmland-sold', 3], ['gte', 'C.displacedFarms', 2]],
    need: (s) => 0.4 + 0.2 * ramp(cnt(s, 'displacedFarms'), 1, 5),
    options: [
      {key: 'do', label: 'Cap the rents', tradeoff: 'The old farms can stay. Fewer houses go up nearby.', effects: [{policy: 'rent-cap', level: '+1'}]},
    ],
  },
  'keep-old-workshops': {
    title: 'Keep the old workshops', category: 'land', cost: 0,
    helps: ['craft'], hurts: ['gentry', 'trade'],
    why: 'Rents are driving the workshops out of the centre. The makers want a quarter of their own.',
    when: ['or', ['tag', 'workshop-displaced', 3], ['gte', 'C.displacedWorkshops', 2]],
    need: (s) => 0.4 + 0.2 * ramp(cnt(s, 'displacedWorkshops'), 1, 5),
    options: [
      {key: 'do', label: 'Keep a workshop quarter', tradeoff: 'The crafts keep a home. That land cannot be built up.', effects: [{policy: 'workshop-quarter', level: 1}]},
      {key: 'cap', label: 'Cap the rents instead', tradeoff: 'Every small business is helped. Building slows.', effects: [{policy: 'rent-cap', level: '+1'}]},
    ],
  },
  'redevelop-centre': {
    title: 'Make room in the centre', category: 'land', cost: 0,
    helps: ['trade', 'gentry'], hurts: ['farm', 'craft'],
    why: 'The centre is too dear for fields and sheds. Let the land go to its best use.',
    when: ['and', ['has', 'institution', 'planning'], ['era', 2], ['or', ['tag', 'farmland-sold', 3], ['tag', 'workshop-displaced', 3], ['gte', 'I.housingPressure', 0.2]]],
    need: (s) => 0.35 + 0.3 * ramp(ind(s, 'housingPressure'), 0.1, 0.4),
    options: [
      {key: 'do', label: 'Tax land by its worth', tradeoff: 'Idle and low-use land is sold and rebuilt. Old trades move out.', effects: [{policy: 'land-value-tax', level: '+1'}]},
    ],
  },
  'seed-exchange': {
    title: 'A seed exchange', category: 'food', cost: 120,
    helps: ['farm'], hurts: [],
    why: 'Some farms grow better grain than others. Sharing seed would lift every harvest.',
    when: ['notag', 'seed-exchange', 25],
    need: (s) => 0.3 + 0.4 * ramp(6 - ind(s, 'foodBalance'), 0, 6),
    options: [
      {key: 'do', label: 'Set it up', tradeoff: 'A small cost. Harvests improve over time.', effects: [{spend: 'cost'}, {tag: 'seed-exchange'}, {deltas: {innovation: 0.02, health: 0.01}}]},
    ],
  },
  'new-fields': {
    title: 'Clear land for new farms', category: 'food', cost: 600,
    helps: ['farm'], hurts: [],
    why: 'The town has more mouths than fields. There is good land past the stream.',
    when: ['lte', 'I.foodBalance', 6],
    need: (s) => 0.3 + 0.6 * ramp(6 - ind(s, 'foodBalance'), 0, 6),
    options: [
      {key: 'do', label: 'Clear two fields', tradeoff: 'It costs {cost}. More food in a year or two.', effects: [{spend: 'cost'}, {build: 'farm', variant: 'field'}, {build: 'farm', variant: 'field'}]},
      {key: 'small', label: 'Clear one field', tradeoff: 'Half the cost. A little more food.', effects: [{spend: 'half'}, {build: 'farm', variant: 'field'}]},
    ],
  },
  'tithe-barn': {
    title: 'A great barn', category: 'food', cost: 700,
    helps: ['farm'], hurts: [],
    why: 'Grain rots in damp sheds. A great barn would keep it dry.',
    when: ['and', ['era', 1], ['lt', 'C.warehouse', 1]],
    need: (s) => 0.25 + 0.3 * ramp(ind(s, 'foodBalance'), 4, 12),
    options: [
      {key: 'do', label: 'Build the barn', tradeoff: 'It costs {cost}. Less grain is lost.', effects: [{spend: 'cost'}, {build: 'warehouse', variant: 'barn'}]},
    ],
  },
  'guild-hall': {
    title: 'A hall for the guild', category: 'trade', cost: 900,
    helps: ['craft'], hurts: [],
    why: 'The guild meets in a tavern. A hall would show the town what makers can do.',
    when: ['notag', 'guild-hall'],
    need: () => 0.35,
    options: [
      {key: 'do', label: 'Build the hall', tradeoff: 'It costs {cost}. The guild grows proud and strong.', effects: [{spend: 'cost'}, {build: 'workshop', variant: 'guild-hall'}, {tag: 'guild-hall'}, {deltas: {prestige: 0.01}}]},
    ],
  },
  'quality-mark': {
    title: 'A mark of quality', category: 'trade', cost: 80,
    helps: ['craft'], hurts: ['trade'],
    why: 'Buyers cannot tell good work from bad. A guild mark would tell them.',
    when: ['notag', 'quality-mark'],
    need: () => 0.3,
    options: [
      {key: 'do', label: 'Grant the mark', tradeoff: 'Our goods earn a name. Outsiders find it harder to sell.', effects: [{spend: 'cost'}, {tag: 'quality-mark'}, {deltas: {prestige: 0.02, market: -0.02}}]},
    ],
  },
  'exchange-hall': {
    title: 'An exchange hall', category: 'trade', cost: 2200,
    helps: ['trade', 'gentry'], hurts: ['craft'],
    why: 'Merchants strike deals in the rain. A hall would draw traders from far away.',
    when: ['lt', 'C.exchange', 1],
    need: (s) => 0.3 + 0.4 * ramp(pr(s, 'riverTrade'), 0.2, 0.6),
    options: [
      {key: 'do', label: 'Build the hall', tradeoff: 'It costs {cost}. Trade will grow.', effects: [{spend: 'cost'}, {build: 'exchange'}, {deltas: {market: 0.03, prestige: 0.02}}]},
    ],
  },
  warehouses: {
    title: 'Warehouses by the river', category: 'trade', cost: 900,
    helps: ['trade', 'labour'], hurts: [],
    why: 'Goods wait on the bank for days. Warehouses would keep them safe and dry.',
    when: ['gte', 'P.riverTrade', 0.2],
    need: (s) => 0.2 + 0.5 * ramp(pr(s, 'riverTrade'), 0.2, 0.6),
    options: [
      {key: 'do', label: 'Build two warehouses', tradeoff: 'It costs {cost}. River trade grows.', effects: [{spend: 'cost'}, {build: 'warehouse'}, {build: 'warehouse'}, {deltas: {riverTrade: 0.02}}]},
    ],
  },
  school: {
    title: 'A new school', category: 'education', cost: 900,
    helps: ['clerical', 'labour'], hurts: [],
    why: 'Children wait for a place at school. Another schoolroom would take {count} more.',
    when: true,
    need: (s) => 0.3 + 0.5 * ramp(0.6 - ind(s, 'literacy'), 0, 0.6),
    options: [
      {key: 'do', label: 'Build the school', tradeoff: 'It costs {cost}. More children learn to read.', effects: [{spend: 'cost'}, {build: 'school'}, {deltas: {learning: 0.02}}]},
    ],
  },
  scholarships: {
    title: 'Scholarships for clever children', category: 'education', cost: 300,
    helps: ['clerical'], hurts: [],
    why: 'A few poor children show great promise. A small fund would send them on.',
    when: ['notag', 'scholarships', 10],
    need: () => 0.3,
    options: [
      {key: 'do', label: 'Fund them', tradeoff: 'It costs {cost}. The town gains clerks and thinkers.', effects: [{spend: 'cost'}, {tag: 'scholarships'}, {deltas: {learning: 0.03, innovation: 0.02}}]},
    ],
  },
  'chapel-upgrade': {
    title: 'A bigger church', category: 'faith', cost: 1400,
    helps: ['clergy'], hurts: [],
    why: 'The faithful stand in the rain on feast days. The chapel needs room.',
    when: ['gte', 'P.faith', 0.35],
    need: (s) => 0.2 + 0.6 * ramp(pr(s, 'faith'), 0.35, 0.7),
    options: [
      {key: 'do', label: 'Build it up', tradeoff: 'It costs {cost}. Faith and fame both grow.', effects: [{spend: 'cost'}, {build: 'chapel', variant: 'upgrade', at: 'hill'}, {deltas: {faith: 0.03, prestige: 0.02}}]},
    ],
  },
  'alms-house': {
    title: 'An alms house', category: 'faith', cost: 500,
    helps: ['labour', 'clergy'], hurts: ['gentry'],
    why: 'Some old people have no one. An alms house would give them bread and a bed.',
    when: ['gte', 'I.inequality', 0.3],
    need: (s) => 0.2 + 0.5 * ramp(ind(s, 'inequality'), 0.3, 0.6),
    options: [
      {key: 'do', label: 'Open it', tradeoff: 'It costs {cost}. Grumbling falls.', effects: [{spend: 'cost'}, {tag: 'alms-house'}, {deltas: {unrest: -0.04, faith: 0.01}}]},
    ],
  },
  'infirmary-house': {
    title: 'A house for the sick', category: 'health', cost: 1000,
    helps: ['labour'], hurts: [],
    why: 'The sick lie at home with no one to tend them. An infirmary would save lives.',
    when: ['lt', 'C.infirmary', 1],
    need: (s) => 0.3 + 0.5 * ramp(0.6 - pr(s, 'health'), 0, 0.4),
    options: [
      {key: 'do', label: 'Build the infirmary', tradeoff: 'It costs {cost}. Fewer die in a plague.', effects: [{spend: 'cost'}, {build: 'infirmary'}, {policy: 'infirmary', level: 1}]},
    ],
  },
  'slum-clearance': {
    title: 'Clear the worst homes', category: 'health', cost: 800,
    helps: ['clerical'], hurts: ['labour'],
    why: 'Some homes are falling down. Sickness starts there.',
    when: ['tag', 'slum', 10],
    need: () => 0.5,
    options: [
      {key: 'do', label: 'Clear and rebuild', tradeoff: 'Health improves. The families who lived there are angry.', effects: [{spend: 'cost'}, {tag: 'slum-cleared'}, {deltas: {health: 0.04, unrest: 0.03}}]},
    ],
  },
  bathhouse: {
    title: 'A public bathhouse', category: 'health', cost: 900,
    helps: ['labour'], hurts: [],
    why: 'Most homes have no tub. A bathhouse would keep people clean and well.',
    when: ['and', ['era', 2], ['lt', 'C.bathhouse', 1]],
    need: (s) => 0.2 + 0.4 * ramp(0.6 - pr(s, 'health'), 0, 0.3),
    options: [
      {key: 'do', label: 'Build it', tradeoff: 'It costs {cost}. People stay healthier.', effects: [{spend: 'cost'}, {build: 'bathhouse'}, {deltas: {health: 0.02}}]},
    ],
  },
  'union-hall': {
    title: 'A hall for the union', category: 'labour', cost: 600,
    helps: ['labour'], hurts: ['gentry'],
    why: 'Workers meet in the fields after dark. They want a hall of their own.',
    when: ['lt', 'C.union-hall', 1],
    need: () => 0.35,
    options: [
      {key: 'do', label: 'Build the hall', tradeoff: 'It costs {cost}. The union grows stronger.', effects: [{spend: 'cost'}, {build: 'union-hall'}]},
    ],
  },
  'sick-fund': {
    title: 'A fund for sick workers', category: 'labour', cost: 400,
    helps: ['labour'], hurts: ['gentry'],
    why: 'A worker who falls ill loses his wage. His family goes hungry.',
    when: ['notag', 'sick-fund', 15],
    need: (s) => 0.2 + 0.4 * ramp(0.5 - pr(s, 'health'), 0, 0.3),
    options: [
      {key: 'do', label: 'Start the fund', tradeoff: 'It costs {cost}. Workers trust the town more.', effects: [{spend: 'cost'}, {tag: 'sick-fund'}, {deltas: {health: 0.02, unrest: -0.03}}]},
    ],
  },
  'call-strike': {
    title: 'The union threatens a strike', category: 'labour', cost: 0, kind: 'demand',
    helps: ['labour'], hurts: ['gentry'],
    why: 'Wages are low and the owners will not talk. The union says it will strike.',
    when: ['and', ['gte', 'P.unrest', 0.25], ['notag', 'strike', 3]],
    need: (s) => 0.6 * ramp(pr(s, 'unrest'), 0.25, 0.6),
    options: [
      {key: 'do', label: 'Raise the wage floor', tradeoff: 'The strike is off. Owners pay more.', effects: [{policy: 'wage-floor', level: '+1'}]},
      {key: 'mediate', label: 'Bring both sides together', tradeoff: 'It costs 300 coin. It may not work.', effects: [{spend: 300}, {deltas: {unrest: -0.05}}]},
      {key: 'refuse_strike', label: 'Let them strike', tradeoff: 'The mills go quiet. Tempers rise.', effects: [{event: 'strike'}]},
    ],
  },
  'watch-house': {
    title: 'A watch house', category: 'civic', cost: 600,
    helps: ['gentry'], hurts: ['labour'],
    why: 'The watch has nowhere to keep its lanterns or hold a thief.',
    when: true,
    need: (s) => 0.25 + 0.5 * ramp(pr(s, 'unrest'), 0.2, 0.6),
    options: [
      {key: 'do', label: 'Build it', tradeoff: 'It costs {cost}. Streets feel safer.', effects: [{spend: 'cost'}, {build: 'watch'}, {deltas: {unrest: -0.03, authority: 0.01}}]},
    ],
  },
  'tavern-licences': {
    title: 'Licences for taverns', category: 'civic', cost: 0,
    helps: ['gentry'], hurts: ['labour'],
    why: 'Fights break out at the taverns most nights. A licence would let us close the worst.',
    when: ['notag', 'tavern-licences', 20],
    need: (s) => 0.3 * ramp(pr(s, 'unrest'), 0.15, 0.5),
    options: [
      {key: 'do', label: 'Require licences', tradeoff: 'Quieter nights. Fewer places to drink.', effects: [{tag: 'tavern-licences'}, {deltas: {unrest: -0.03, authority: 0.02}}]},
    ],
  },
  theatre: {
    title: 'A playhouse', category: 'faith', cost: 1600,
    helps: ['trade', 'gentry'], hurts: ['clergy'],
    why: 'Players come through town but have no stage. A playhouse would keep them here.',
    when: ['and', ['era', 2], ['lt', 'C.theatre', 1]],
    need: (s) => 0.2 + 0.4 * ramp(ind(s, 'avgWealth'), 120, 300),
    options: [
      {key: 'do', label: 'Build the playhouse', tradeoff: 'It costs {cost}. Visitors and fame follow.', effects: [{spend: 'cost'}, {build: 'theatre'}, {deltas: {prestige: 0.03}}]},
    ],
  },
  carnival: {
    title: 'A carnival week', category: 'faith', cost: 700,
    helps: ['trade', 'labour'], hurts: ['clergy'],
    why: 'Other towns hold a carnival. Ours could be the finest in the valley.',
    when: ['and', ['era', 3], ['notag', 'carnival', 5]],
    need: (s) => 0.25 + 0.3 * ramp(pr(s, 'prestige'), 0.3, 0.7),
    options: [
      {key: 'do', label: 'Hold the carnival', tradeoff: 'It costs {cost}. Our name travels far.', effects: [{spend: 'cost'}, {tag: 'carnival'}, {event: 'fair', choice: 'fund'}, {deltas: {prestige: 0.05}}]},
    ],
  },
};

for (const [id, t] of Object.entries(TEMPLATES)) t.id = id;

// A tax may be lowered if it was not changed lately and the town keeps some tax after.
function canCut(state, id) {
  const all = ['property-tax', 'income-tax', 'land-value-tax'].reduce((n, t) => n + levelOf(state, t), 0);
  return levelOf(state, id) >= 1 && all >= 2 && !subjectInFlight(state, `rule:${id}`);
}

// The options a template would offer now.
const offered = (state, t) => t.options.filter((o) => (o.era ?? 0) <= (state.era ?? 0) && (!o.when || o.when(state)));

// How much each rule is wanted, by the facts of the town (0..1). Default 0.3.
const RULE_NEED = {
  commons: (s) => 0.3 + 0.4 * ramp(ind(s, 'inequality'), 0.2, 0.5),
  enclosure: (s) => 0.2 + 0.4 * ramp(6 - ind(s, 'foodBalance'), 0, 6) + 0.2 * ramp(s.traits.market, 0, 0.5),
  granary: (s) => 0.2 + 0.7 * ramp(8 - ind(s, 'foodBalance'), 0, 8),
  'grain-import': (s) => 0.8 * ramp(4 - ind(s, 'foodBalance'), 0, 4),
  'fast-days': (s) => 0.5 * ramp(3 - ind(s, 'foodBalance'), 0, 3),
  drainage: (s) => 0.25 + 0.3 * ramp(floodRisk(s), 0.2, 0.6),
  wells: (s) => 0.3 + 0.6 * ramp(0.6 - pr(s, 'health'), 0, 0.4),
  sewers: (s) => 0.2 + 0.6 * ramp(0.6 - pr(s, 'health'), 0, 0.4) + 0.2 * ramp(ind(s, 'density'), 0.4, 0.8),
  'smoke-limits': (s) => 0.6 * ramp(s.traits.industry, 0.2, 0.7) + 0.3 * ramp(0.8 - pr(s, 'ecology'), 0, 0.4),
  'clean-water-rule': (s) => 0.5 * ramp(0.8 - pr(s, 'ecology'), 0, 0.4),
  'riverbank-protect': (s) => 0.2 + 0.6 * ramp(floodRisk(s), 0.2, 0.6),
  'mill-rights': (s) => 0.3 + 0.4 * ramp(s.traits.industry, -0.1, 0.4),
  'wage-floor': (s) => 0.3 + 0.6 * ramp(ind(s, 'inequality'), 0.3, 0.6),
  'hours-cap': (s) => 0.2 + 0.4 * ramp(0.5 - pr(s, 'health'), 0, 0.3),
  'free-trade': (s) => 0.3 + 0.5 * ramp(pr(s, 'riverTrade'), 0.2, 0.6),
  tolls: (s) => 0.2 + 0.5 * ramp(1 - ind(s, 'treasuryYears'), 0, 1),
  'property-tax': (s) => 0.6 * ramp(0.8 - ind(s, 'treasuryYears'), 0, 0.8),
  'income-tax': (s) => 0.5 * ramp(0.6 - ind(s, 'treasuryYears'), 0, 0.6),
  'free-schooling': (s) => 0.3 + 0.5 * ramp(0.6 - ind(s, 'literacy'), 0, 0.5),
  'feast-days': (s) => 0.3 + 0.3 * ramp(pr(s, 'unrest'), 0.1, 0.4),
  tithe: (s) => 0.25 + 0.3 * ramp(pr(s, 'faith'), 0.3, 0.6),
  lamps: (s) => 0.2 + 0.5 * ramp(pr(s, 'unrest'), 0.1, 0.4),
  curfew: (s) => 0.7 * ramp(pr(s, 'unrest'), 0.35, 0.7),
  'open-moot': (s) => 0.5 * ramp(pr(s, 'unrest'), 0.15, 0.5),
  'paving-fund': (s) => 0.3 + 0.5 * ramp(ind(s, 'traffic'), 0.3, 0.8),
  zoning: (s) => 0.2 + 0.5 * ramp(ind(s, 'density'), 0.4, 0.8),
  'park-reserve': (s) => 0.2 + 0.4 * ramp(ind(s, 'density'), 0.3, 0.7),
  'land-value-tax': (s) => 0.4 * ramp(ind(s, 'housingPressure'), 0.2, 0.6),
  'market-charter': (s) => 0.4 + 0.2 * ramp(s.traits.market, -0.2, 0.3),
  'charter-of-rights': (s) => 0.6 * ramp(pr(s, 'unrest'), 0.3, 0.7),
};

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const FIRST = ['Mara', 'Tamsin', 'Hal', 'Edda', 'Osric', 'Wynn', 'Bryn', 'Isolde', 'Corin', 'Petra', 'Aldo',
  'Nell', 'Jory', 'Sabine', 'Tobin', 'Ivo', 'Greta', 'Linus', 'Maud', 'Owen', 'Rhea', 'Silas', 'Una', 'Ezra'];
const LAST = ['Ode', 'Brennick', 'Thatcher', 'Mill', 'Fenwick', 'Cobb', 'Ashdown', 'Weller', 'Hale', 'Rook',
  'Marsh', 'Fairweather', 'Stone', 'Penrose', 'Holt', 'Garrow', 'Lark', 'Underhill', 'Croft', 'Vane'];

function askerFor(state, kind) {
  const role = INSTITUTIONS[kind]?.asker?.role ?? 'member';
  const traits = [...(INSTITUTIONS[kind]?.asker?.traits ?? [])];
  const h = hash32((state.seed ?? 1) * 31 + kind.length * 977 + [...kind].reduce((a, c) => a * 33 + c.charCodeAt(0), 7));
  return {name: `${FIRST[h % FIRST.length]} ${LAST[(h >>> 8) % LAST.length]}`, role, traits};
}

export function bodyName(state, kind, body = null) {
  if (kind === 'ward' || String(kind).startsWith('ward:')) {
    const cid = body?.centreId ?? Number(String(body?.id ?? kind).split(':')[1]);
    return `${centreName(state, cid)} Ward Council`;
  }
  const def = INSTITUTIONS[kind];
  if (!def) return kind;
  let name = def.name;
  for (const [era, n] of def.names ?? []) if ((state.era ?? 0) >= era) name = n;
  return name;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export function createBody(state, kind, budgetShare = 0.06) {
  return {
    id: kind, kind, name: bodyName(state, kind), foundedYear: state.time.year, status: 'active',
    budgetShare, power: 0.4, patience: 1, metrics: {}, lastProposalMonth: monthIndex(state.time),
    delegated: false, delegateCap: 0, standingOrders: [], accepted: 0, refused: 0, expired: 0,
    waningSince: null, declineSince: null, asker: askerFor(state, kind), funds: 0, spentThisYear: 0,
    report: [], nextDraftMonth: monthIndex(state.time) + 3,
  };
}

// Fill in governance fields on a fresh or restored state. Idempotent.
export function initGovernance(state) {
  state.institutions ??= [];
  state.policies ??= {};
  state.docket ??= [];
  state.cardHistory ??= [];
  state.events ??= {active: [], cooldownUntil: {}};
  state.events.cooldownUntil ??= {};
  state.events.active ??= [];
  state.factions ??= [];
  state.answerLog ??= [];
  state.chronicle ??= {entries: [], summary: null};
  state.governance ??= {petitionWait: {}, cardsThisYear: 0, nextCardId: 1, lastSessionMonth: -1, sliceAnswers: {}, flags: {}};
  state.governance.petitionWait ??= {};
  state.governance.sliceAnswers ??= {};
  state.governance.flags ??= {};
  let moot = state.institutions.find((b) => b.kind === 'moot');
  if (!moot) {
    moot = createBody(state, 'moot', 0);
    moot.foundedYear = 0;
    state.institutions.unshift(moot);
  }
  for (const body of state.institutions) normaliseBody(state, body);
  return state;
}

function normaliseBody(state, body) {
  const fresh = createBody(state, body.kind, body.budgetShare ?? 0);
  for (const [k, v] of Object.entries(fresh)) if (body[k] === undefined) body[k] = v;
  body.name = bodyName(state, body.kind, body);
  if (!body.asker?.traits) body.asker = {...askerFor(state, body.kind), ...(body.asker?.name ? {name: body.asker.name} : {})};
}

export const bodyOf = (state, id) => state.institutions.find((b) => b.id === id || b.kind === id) ?? null;
export const activeBodies = (state) => state.institutions.filter((b) => b.status === 'active');
export const liveBodies = (state) => state.institutions.filter((b) => b.status === 'active' || b.status === 'waning');

// ---------------------------------------------------------------------------
// Power, support, delegation
// ---------------------------------------------------------------------------

// Share of households in the body's constituency (0..1).
export function supportShare(state, kind) {
  const c = INSTITUTIONS[kind]?.constituency;
  const total = state.households.length || 1;
  if (!c) return kind === 'moot' ? 1 : 0.3;
  let n = 0;
  for (const h of state.households) {
    if (c.trades && !c.trades.includes(h.trade)) {
      if (!(c.faithBand !== undefined && h.faithBand >= c.faithBand)) continue;
    }
    if (c.maxWealthBand !== undefined && wealthBandOf(state, h) > c.maxWealthBand) continue;
    if (c.nearRiver && !nearRiver(state, h)) continue;
    n++;
  }
  return n / total;
}

function nearRiver(state, h) {
  const d = state.districts?.find((x) => x.id === h.districtId);
  if (!d) return true;
  return d.nearRiver ?? (d.character === 'quays' || Math.abs((d.centroid?.x ?? 0) - riverX(d.centroid?.z ?? 0)) < 30);
}

export function wealthBandOf(state, h) {
  const [t1, t2] = state.bands?.wealth ?? [60, 200];
  const w = h.wealth ?? h.savings ?? 0;
  return w < t1 ? 0 : w < t2 ? 1 : 2;
}

export function computePower(state, body) {
  const record = body.accepted / (body.accepted + body.refused + 1);
  if (body.kind === 'ward') {
    const share = state.households.filter((h) => h.centreId === body.centreId).length / Math.max(1, state.households.length);
    return Math.max(0, Math.min(1, 0.3 + 0.4 * record + 0.3 * share));
  }
  const guild = body.kind === 'trades-guild' ? (levelOf(state, 'guild-vote') ? 0.2 : 0) : 0;
  return Math.max(0, Math.min(1, 0.3 + 0.4 * record + 0.3 * supportShare(state, body.kind) + guild));
}

export const canDelegate = (state, body) =>
  body.kind !== 'moot' && body.status === 'active' && ((state.era ?? 0) >= 3 || (body.accepted >= 4 && body.refused === 0));

export function setDelegated(state, bodyId, on, cap = 0) {
  const body = bodyOf(state, bodyId);
  if (!body || (on && !canDelegate(state, body))) return false;
  if (!!body.delegated === !!on && body.delegateCap === cap) return true;
  body.delegated = !!on;
  body.delegateCap = Math.max(0, Math.round(cap || 0));
  addChronicle(state, fill(on ? LINES.delegated : LINES.undelegated, {name: `The ${body.name}`}), 'decision', {body: body.id});
  return true;
}

// Standing orders: {id?, match: {category?, templateId?, policy?}, action: 'approve'|'refuse', maxCost?}
export function setStandingOrder(state, bodyId, order) {
  const body = bodyOf(state, bodyId);
  if (!body || !order) return false;
  if (!(state.era >= 3 || body.delegated)) return false;
  body.standingOrders ??= [];
  const id = order.id ?? `so${body.standingOrders.length + 1}`;
  const at = body.standingOrders.findIndex((o) => o.id === id);
  if (order.remove) {
    if (at >= 0) body.standingOrders.splice(at, 1);
    return true;
  }
  const clean = {id, match: {...(order.match ?? {})}, action: order.action === 'refuse' ? 'refuse' : 'approve',
    maxCost: Number.isFinite(order.maxCost) ? order.maxCost : null};
  if (at >= 0) body.standingOrders[at] = clean;
  else body.standingOrders.push(clean);
  return true;
}

// Which standing order (if any) settles this card.
export function standingOrderFor(state, card) {
  for (const body of [bodyOf(state, card.from), bodyOf(state, 'moot')]) {
    for (const o of body?.standingOrders ?? []) {
      const m = o.match ?? {};
      if (m.category && m.category !== card.category) continue;
      if (m.templateId && m.templateId !== card.templateId) continue;
      if (m.policy && m.policy !== card.data?.policy) continue;
      if (o.action === 'approve' && o.maxCost != null && (card.cost ?? 0) > o.maxCost) continue;
      return o;
    }
  }
  return null;
}

export function dissolveBody(state, bodyId) {
  const body = bodyOf(state, bodyId);
  if (!body || body.kind === 'moot' || body.status === 'dissolved') return false;
  if (body.power >= 0.5) delta(state, 'unrest', 0.05, `dissolve:${body.kind}`);
  endBody(state, body, LINES.bodyDissolvedByYou);
  return true;
}

function endBody(state, body, line) {
  body.status = 'dissolved';
  body.delegated = false;
  body.dissolvedYear = state.time.year;
  setTag(state, `dissolved:${body.kind}`);
  state.docket = state.docket.filter((c) => c.from !== body.id || c.kind === 'report');
  addChronicle(state, fill(line, {name: `The ${body.name}`}), 'line', {body: body.id});
  invalidateCtx(state);
}

// ---------------------------------------------------------------------------
// Emergence: petitions to form
// ---------------------------------------------------------------------------

export function emergenceHolds(state, kind) {
  const def = INSTITUTIONS[kind];
  if (!def?.when) return false;
  const ctx = makeCtx(state);
  governanceCounts(state, ctx);
  return holds(def.when, ctx);
}

function canPetition(state, kind) {
  const existing = state.institutions.find((b) => b.kind === kind);
  if (existing && existing.status !== 'dissolved') return false;
  if (existing?.dissolvedYear != null && state.time.year - existing.dissolvedYear < 10) return false;
  if (!holds(notRefused(kind), makeCtx(state))) return false;
  const wait = state.governance.petitionWait[kind];
  if (wait != null && monthIndex(state.time) < wait) return false;
  if (state.docket.some((c) => c.kind === 'petition' && c.data?.forms === kind)) return false;
  return true;
}

export function petitionCard(state, kind) {
  const def = INSTITUTIONS[kind];
  const name = bodyName(state, kind);
  const tax = fiscalBase(state);
  const purse = (share) => coin(Math.round(tax * share));
  return makeCard(state, {
    kind: 'petition', from: 'moot', templateId: `form:${kind}`, category: 'civic',
    title: def.petition.title, why: def.petition.why,
    asker: askerFor(state, kind), urgency: 1, cost: 0,
    helps: def.constituency?.trades ?? [], hurts: [],
    data: {forms: kind},
    options: [
      {key: 'standard', label: `Form the ${name}`, tradeoff: `A fair purse: about ${purse(0.06)} a year.`, effects: [{form: kind, budget: 0.06}]},
      {key: 'small', label: 'Form it with a small purse', tradeoff: `About ${purse(0.03)} a year. It can do little alone.`, effects: [{form: kind, budget: 0.03}]},
      {key: 'generous', label: 'Form it and fund it well', tradeoff: `About ${purse(0.1)} a year. It will get things done.`, effects: [{form: kind, budget: 0.1}]},
      {key: 'not_now', label: 'Not now', tradeoff: 'They will ask again in three years.', effects: [{wait: 36}]},
      {key: 'refuse', label: 'Refuse', tradeoff: 'They will not ask again for fifteen years. Their backers will be angry.', effects: [{refuseBody: kind}]},
    ],
  });
}

// All purses together take at most this share of tax (sim-core pays
// budgetShare × tax into each). Grants beyond it are scaled down alike.
export const PURSE_CAP = 0.25;

export function balancePurses(state) {
  const live = state.institutions.filter((b) => b.status === 'active' && b.kind !== 'moot');
  const granted = live.reduce((n, b) => n + (b.grantShare ?? b.budgetShare ?? 0), 0);
  // A full chest lets the bodies spend more (up to 35% of tax together).
  const cap = PURSE_CAP + 0.1 * ramp(ind(state, 'treasuryYears'), 4, 8);
  const scale = granted > cap ? cap / granted : 1;
  for (const b of state.institutions) {
    if (b.kind === 'moot') continue;
    b.grantShare ??= b.budgetShare ?? 0;
    b.budgetShare = b.status === 'active' ? Math.round(b.grantShare * scale * 10000) / 10000 : 0;
  }
}

export function formBody(state, kind, budgetShare = 0.06) {
  let body = state.institutions.find((b) => b.kind === kind);
  if (body && body.status !== 'dissolved') return body;
  if (body) state.institutions.splice(state.institutions.indexOf(body), 1);
  body = createBody(state, kind, budgetShare);
  body.grantShare = budgetShare;
  body.power = computePower(state, body);
  state.institutions.push(body);
  balancePurses(state);
  setTag(state, `formed:${kind}`);
  delete state.governance.petitionWait[kind];
  invalidateCtx(state);
  addChronicle(state, fill(LINES.bodyFounded, {name: `The ${body.name}`}), 'moment', {body: body.id, founded: true});
  return body;
}

export function refuseBody(state, kind) {
  setTag(state, `refused:${kind}`);
  if (String(kind).startsWith('ward:')) {
    const cid = Number(kind.split(':')[1]);
    for (const f of state.factions) if (f.centreId === cid) f.mood = Math.max(0, f.mood - 0.1);
    delta(state, 'unrest', 0.02, `refused:${kind}`);
    addChronicle(state, fill(LINES.bodyRefused, {name: `a council for ${centreName(state, cid)}`}), 'decision', {body: kind});
    return;
  }
  delta(state, 'unrest', 0.03, `refused:${kind}`);
  for (const f of factionGroup(state, INSTITUTIONS[kind]?.faction)) f.mood = Math.max(0, f.mood - 0.15);
  addChronicle(state, fill(LINES.bodyRefused, {name: `the ${bodyName(state, kind)}`}), 'decision', {body: kind});
}

// ---------------------------------------------------------------------------
// Drafting: which templates a body may draft now, with need scores
// ---------------------------------------------------------------------------

function ruleTemplate(state, body, pid) {
  const def = POLICIES[pid];
  const level = levelOf(state, pid);
  if (level >= def.maxLevel) return null;
  // The Rule Book grows with the town: a rule is offered once its chapter is open.
  if (level === 0 && (state.era ?? 0) < (CATEGORY_ERA[def.category] ?? 0)) return null;
  if (!canAdopt(state, pid, level + 1)) return null;
  let need = (RULE_NEED[pid]?.(state) ?? 0.3) * (level > 0 ? 0.7 : 1);
  // A body brings a brand-new rule at most every few years; between them it
  // brings works, buildings and changes to rules already standing.
  // The fuller the Rule Book, the longer the gap.
  const inForce = Object.values(state.policies).filter((p) => p.level > 0).length;
  if (level === 0 && state.time.year - (body.lastAdoptYear ?? -Infinity) < ADOPT_GAP_YEARS + Math.floor(inForce / 5)) need *= 0.15;
  // The town should not take on upkeep it cannot pay (treasury under half a year).
  if (upkeepFor(state, pid, level + 1) > 0 && short(state)) need *= 0.2;
  return {id: `${level ? 'raise' : 'adopt'}:${pid}`, policy: pid, need: clamp01(need), title: def.title};
}

const short = (state) => (state.treasury ?? 0) < 0 || (state.indicators?.treasuryYears ?? 1) < 0.5;

function easeTemplate(state) {
  // The Moot offers to ease the rule that costs most: against the grain, in
  // tension, or simply too dear when the coffers are empty.
  const tensions = detectTensions(state);
  const broke = short(state);
  let total = 0;
  for (const [pid, p] of Object.entries(state.policies)) if (p.level > 0) total += upkeepFor(state, pid, p.level);
  let best = null;
  for (const [pid, p] of Object.entries(state.policies)) {
    if (!POLICIES[pid] || p.level <= 0 || POLICIES[pid].oneOff || TAX_RULES.has(pid)) continue;
    const grain = againstGrain(state, pid, p.level).against ? 0.5 : 0;
    const torn = tensions.some((t) => t.left === pid || t.right === pid) ? 0.3 : 0;
    const dear = broke && total > 0 ? 0.4 + 0.6 * (upkeepFor(state, pid, p.level) / total) : 0;
    const score = grain + torn + dear;
    if (score > 0 && (!best || score > best.need)) best = {id: `ease:${pid}`, policy: pid, need: score, title: `Ease ${POLICIES[pid].title.toLowerCase()}`};
  }
  return best;
}

// opts.salient: include the high-salience templates (bridges) that the bridge
// watch drafts directly; ordinary drafting leaves them out.
export function eligibleTemplates(state, body, opts = {}) {
  const def = INSTITUTIONS[body.kind];
  const ctx = makeCtx(state);
  governanceCounts(state, ctx);
  const out = [];
  let candidates = null; // sim-world's works are costly; ask only when a template needs them
  for (const tid of def.templates ?? []) {
    const t = TEMPLATES[tid];
    if (!t || (t.when !== true && !holds(body.centreId != null ? forCentre(t.when, body.centreId) : t.when, ctx))) continue;
    if (!!t.salient !== !!opts.salient) continue;
    if (t.dynamic === 'ease') {
      const e = easeTemplate(state);
      if (e && !subjectBlocked(state, [`rule:${e.policy}`], {need: e.need})) out.push({...e, template: tid});
      continue;
    }
    const options = offered(state, t);
    if (!options.length) continue;
    let work = null;
    if (t.work) {
      const pool = t.work === 'bridge-basic' ? basicBridges(state) : t.work === 'bridge-upgrade' ? bridgeUpgrades(state)
        : (candidates ??= candidateWorks(state)).filter((w) => w.kind === t.work);
      work = pool.find((w) => (!t.workFilter || t.workFilter(w)) && !blocked(state, tid, w.id, w));
      if (!work) continue;
    } else if (blocked(state, tid, null)) {
      continue;
    }
    const spends = ((t.cost ?? 0) > 0 || !!t.work) && !t.returnsOnDemand;
    const need = clamp01(t.need(state, body, work) * declineDamp(state, tid) * (spends ? spendMood(state) : 1));
    // Not while the same thing is open, under way, or settled lately (demand-led
    // plans set their own return after a decline: waitsForDemand).
    if (subjectBlocked(state, templateSubjects(tid, body.centreId ?? null, options), {need, declines: !t.returnsOnDemand})) continue;
    out.push({id: tid, template: tid, need, title: t.title, workId: work?.id ?? null, work: t.work === 'bridge-basic' || t.work === 'bridge-upgrade' ? work : null});
  }
  const rules = body.kind === 'moot' ? mootRules(state) : def.policies;
  for (const pid of rules) {
    const r = ruleTemplate(state, body, pid);
    if (!r || blocked(state, r.id, null)) continue;
    r.need *= declineDamp(state, r.id);
    if (subjectBlocked(state, [`rule:${pid}`], {need: r.need})) continue;
    // The Moot speaks for fields that have no body of their own yet, a little less keenly.
    if (body.kind === 'moot' && !POLICIES[pid].by?.includes('moot')) r.need *= 0.4;
    out.push(r);
  }
  // A petition's focus lifts plans in that category.
  if (body.focus && body.focus.until >= monthIndex(state.time)) {
    for (const t of out) {
      const cat = t.policy ? POLICIES[t.policy].category : TEMPLATES[t.template]?.category;
      if (cat === body.focus.category) t.need = clamp01(t.need + (body.focus.boost ?? 0.35));
    }
  }
  // Nothing already on the docket (shown or queued) is drafted again, by anyone.
  const live = new Set(state.docket.flatMap((c) => [c.templateId, ...(c.data?.cards ?? []).map((x) => x.templateId), ...(c.data?.batch ?? []).map((x) => x.templateId)]));
  return out.filter((t) => !live.has(t.id) && !recentlyRefused(state, body, t.id, TEMPLATES[t.template]?.returnsOnDemand ? t.workId : null))
    .sort((a, b) => b.need - a.need || a.id.localeCompare(b.id));
}

// How keen bodies are on plans that cost coin: keener with years of spending
// in the chest, shy when it runs low.
function spendMood(state) {
  const ty = ind(state, 'treasuryYears');
  if (short(state)) return 0.4;
  return 1 + 0.6 * ramp(ty, 3, 8);
}

// A ward's conditions name its own centre: '{centreId}' in tag names.
const forCentre = (expr, id) => JSON.parse(JSON.stringify(expr).replaceAll('{centreId}', String(id)));

// Anti-nag, for every template and place: after Not now, 3 years; after
// Refuse, 6; after Do it, never again for the same place.
export const COOLDOWN_YEARS = {not_now: 3, refuse: 6};

function blocked(state, templateId, place, work = null) {
  const year = state.time.year;
  if (TEMPLATES[templateId]?.returnsOnDemand) return waitsForDemand(state, templateId, work);
  for (let i = state.cardHistory.length - 1; i >= 0; i--) {
    const h = state.cardHistory[i];
    if (year - h.year > 25) break;
    if (h.templateId !== templateId) continue;
    if (place != null && h.place != null && h.place !== place) continue;
    const declined = h.choice === 'refuse' || h.outcome === 'refused' || h.outcome === 'lost' ? 'refuse'
      : h.choice === 'not_now' || h.choice === 'planks' || h.outcome === 'deferred' || h.outcome === 'expired' ? 'not_now' : null;
    if (declined) return year - h.year < COOLDOWN_YEARS[declined];
    if (place != null && h.place === place && h.outcome === 'accepted') return true;
    return false;
  }
  return false;
}

// After Not now (or Refuse), a demand-led plan returns once its demand has
// doubled since, and no sooner than a year later. Building it ends it there.
function waitsForDemand(state, templateId, work) {
  for (let i = state.cardHistory.length - 1; i >= 0; i--) {
    const h = state.cardHistory[i];
    if (h.templateId !== templateId) continue;
    // Each crossing (or bridge) keeps its own count: a refusal at one is no answer for another.
    if (h.place != null && work?.id != null && h.place !== work.id) continue;
    if (h.outcome === 'accepted' && h.choice === 'do') return h.place === work?.id;
    if (state.time.year - h.year < 1) return true;
    const now = TEMPLATES[templateId].work === 'bridge-upgrade' ? Math.max(bridgeLoad(work), 1 - (work?.condition ?? 1)) : bridgeDemand(work);
    return now < (TEMPLATES[templateId].returnFactor ?? 2) * (h.demand ?? 0);
  }
  return false;
}

// Each time the player declined a template in the last ten years, its need halves.
function declineDamp(state, templateId) {
  if (TEMPLATES[templateId]?.returnsOnDemand) return 1;
  const year = state.time.year;
  let n = 0;
  for (let i = state.cardHistory.length - 1; i >= 0; i--) {
    const h = state.cardHistory[i];
    if (year - h.year > 10) break;
    if (h.templateId === templateId && (h.choice === 'refuse' || h.choice === 'not_now' || h.outcome === 'lost')) n++;
  }
  return 0.5 ** n;
}

// How far a work's wear is past the threshold sim-world used to offer it (0..1).
function workPressure(w) {
  if (!w) return 0;
  const threshold = w.tier === 3 ? 600 : 2000;   // sim-world PAVE_WEAR
  return ramp(w.wear ?? threshold, threshold, threshold * 3);
}

// Basic cart-bridge candidates: sim-world's town-scaled crossings
// (bridgeCandidates(state, {basic: true})), cached for half a year.

// How strong a basic crossing's demand is: 1 at sim-world's offer level.
export function bridgeDemand(w) {
  if (!w) return 0;
  return Math.max((w.crossings ?? 0) / 12, (w.share ?? 0) / 0.08);   // sim-world: 12 crossings or a 0.08 share
}
const basicCache = {
  get: (state) => state.governance?.basicCache ?? null,
  set: (state, value) => { if (state.governance) state.governance.basicCache = value; },
};
// How loaded a bridge is: traffic over capacity (1 = full), from sim-world's fields.
export function bridgeLoad(w) {
  if (!w) return 0;
  if (Number.isFinite(w.load)) return w.load;
  return w.capacity ? (w.traffic ?? 0) / w.capacity : 0;
}

const upgradeCache = {
  get: (state) => state.governance?.upgradeCache ?? null,
  set: (state, value) => { if (state.governance) state.governance.upgradeCache = value; },
};
export const upgradesFresh = (state) => {
  const cached = upgradeCache.get(state);
  return !!cached && monthIndex(state.time) - cached.month < 3;
};
export function bridgeUpgrades(state) {
  const month = monthIndex(state.time);
  const cached = upgradeCache.get(state);
  if (cached && month - cached.month < 3) return cached.list;
  if (typeof worksApi.bridgeUpgradeCandidates !== 'function') return [];
  let list = [];
  try {
    list = worksApi.bridgeUpgradeCandidates(state) ?? [];
  } catch {
    list = [];
  }
  for (const w of list) w.id ??= w.key ?? `bridge-upgrade:${w.bridgeId}`;
  upgradeCache.set(state, {month, list});
  return list;
}
export const draftsUpgrades = (body) => (INSTITUTIONS[body?.kind]?.templates ?? []).includes('bridge-upgrade');

export const basicFresh = (state) => {
  const cached = basicCache.get(state);
  return !!cached && monthIndex(state.time) - cached.month < WORKS_FRESH_MONTHS;
};
export const draftsBasicBridge = (body) => (INSTITUTIONS[body?.kind]?.templates ?? []).includes('cart-bridge');

export function basicBridges(state) {
  const month = monthIndex(state.time);
  const cached = basicCache.get(state);
  if (cached && month - cached.month < WORKS_FRESH_MONTHS) return cached.list;
  let list = [];
  try {
    list = worldBridges(state, {basic: true}) ?? [];
  } catch {
    list = [];
  }
  for (const w of list) w.id ??= w.key;
  basicCache.set(state, {month, list});
  return list;
}

// High-salience bridges: when a crossing has the demand, its body (the River
// Authority, else Planning, else the Moot) drafts the card at once and it
// skips the session queue. Checked quarterly.
export function bridgeWatch(state) {
  if (monthIndex(state.time) % 3 !== 0) return null;
  // Only with a fresh works list: the scheduler refreshes it on a tick of its own.
  if (!worksFresh(state)) return null;
  if (state.docket.some((c) => c.data?.bridge)) return null;
  const sitting = (k) => activeBodies(state).find((b) => b.kind === k);
  const era = state.era ?? 0;
  const owners = [sitting('river-authority'), era >= 2 ? sitting('planning') : null, bodyOf(state, 'moot')].filter(Boolean);
  for (const body of owners) {
    const choices = eligibleTemplates(state, body, {salient: true});
    const choice = choices.find((c) => c.template === 'bridge');
    if (!choice) continue;
    const card = draftCard(state, body, choice);
    card.data.bridge = true;
    card.salient = true;
    return addCard(state, card);
  }
  return null;
}

export const ADOPT_GAP_YEARS = 6;

// Twice refused, a plan is shelved for 25 years (single declines: see blocked()).
function recentlyRefused(state, body, templateId, place = null) {
  const year = state.time.year;
  let refusals = 0;
  for (let i = state.cardHistory.length - 1; i >= 0; i--) {
    const h = state.cardHistory[i];
    if (year - h.year > 25) break;
    if (h.from === body.id && h.templateId === templateId && (place == null || h.place == null || h.place === place) &&
      (h.choice === 'refuse' || h.outcome === 'lost' || h.outcome === 'refused')) refusals++;
  }
  return refusals >= 2;
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const TAX_RULES = new Set(['property-tax', 'income-tax', 'tithe', 'land-value-tax']);

// The Moot drafts its own rules, plus any rule whose bodies do not sit yet.
function mootRules(state) {
  const sitting = new Set(activeBodies(state).map((b) => b.kind));
  return Object.keys(POLICIES).filter((pid) => {
    const by = POLICIES[pid].by ?? [];
    return by.includes('moot') || !by.some((k) => sitting.has(k));
  });
}

// Counts the emergence conditions read beyond sim-core's C.* table: rules in
// force by field, and the share of households in a trade.
const FIELD_COUNTS = {
  rulesLandFood: ['land', 'food'], rulesCraft: ['labour'], rulesTrade: ['trade'], rulesEducation: ['education'],
  rulesHealth: ['health'], rulesStreets: ['infrastructure'], rulesFaith: ['faith'],
};

export function governanceCounts(state, ctx = makeCtx(state)) {
  const C = ctx.C;
  if (C._gov === state.time.tick) return C;
  for (const [key, cats] of Object.entries(FIELD_COUNTS)) {
    let n = 0;
    for (const [id, p] of Object.entries(state.policies)) if (p.level > 0 && cats.includes(POLICIES[id]?.category)) n++;
    C[key] = n;
  }
  const total = state.households.length || 1;
  C.coin = state.treasury ?? 0;
  const disp = state.governance?.displaced ?? {};
  const recent = (kind) => Object.entries(disp[kind] ?? {}).filter(([y]) => state.time.year - Number(y) <= 3).reduce((n, [, v]) => n + v, 0);
  C.displacedFarms = recent('farm');
  C.displacedWorkshops = recent('workshop');
  C.crossings = Object.values(state.roads?.xings ?? {}).reduce((a, b) => Math.max(a, b), 0);
  // Mud: spring, rain, or a flood this year.
  C.muddy = state.time.month <= 2 || (state.weather?.rain ?? 0) >= 0.3 || state.tags?.flood === state.time.year ? 1 : 0;
  C.farmShare = state.households.filter((h) => h.trade === 'farm').length / total;
  C.labourShare = state.households.filter((h) => h.trade === 'labour' || h.trade === 'none').length / total;
  C._gov = state.time.tick;
  return C;
}

// Bodies that should draft this month.
export function bodiesDueToDraft(state) {
  const m = monthIndex(state.time);
  return activeBodies(state).filter((b) => m >= (b.nextDraftMonth ?? 0) &&
    !state.docket.some((c) => c.from === b.id && c.kind !== 'report'));
}

export const DRAFT_EVERY_MONTHS = 6;
// Share of a body's purse spent each year on its running costs.
export const RUNNING_SHARE = 0.4;

export function markDrafted(state, body) {
  const m = monthIndex(state.time);
  body.lastProposalMonth = m;
  body.nextDraftMonth = m + DRAFT_EVERY_MONTHS;
}

// Build a docket card for one of the body's eligible templates.
export function draftCard(state, body, choice) {
  const name = body.name;
  const facts = factsFor(state, body, choice);
  if (choice.policy && !choice.template) return ruleCard(state, body, choice, facts);
  const t = TEMPLATES[choice.template];
  if (t.dynamic === 'ease') return easeCard(state, body, choice);
  const work = choice.work ?? (choice.workId ? candidateWorks(state).find((w) => w.id === choice.workId) : null);
  // A basic cart bridge carries sim-world's (cheap, era-scaled) cost; the card spends it up front.
  const basic = t.work === 'bridge-basic';
  const cost = Math.round(work?.cost ?? (t.costFn ? t.costFn(state) : (t.cost ?? 0) * costScale(state)));
  const vars = {...facts, cost: coin(cost), place: work?.place ?? facts.place, homes: count(work?.demolish?.length ?? 2),
    centre: body.centreId != null ? centreName(state, body.centreId) : 'the town', centreId: body.centreId ?? ''};
  if (t.work === 'bridge-upgrade' && work) {
    vars.state = bridgeLoad(work) >= 1 ? 'too small for its traffic' : 'worn and creaking';
    vars.place = work.place ?? `at ${work.where ?? 'the ford'}`;
  }
  const optionsFor = (o) => {
    const variant = o.effects?.find((e) => e.work)?.variant;
    const wo = basic ? null : work?.options?.find((x) => x.key === variant) ?? (o.effects?.some((e) => e.work) ? work?.options?.[0] : null);
    const c = wo ? wo.cost ?? 0 : optionCost(o, cost);
    const effects = body.centreId == null ? o.effects : o.effects.map((e) => ({...e, ...(e.tag ? {tag: fill(e.tag, vars)} : {}), ...(e.at === 'centre' ? {at: `centre:${body.centreId}`} : {})}));
    return {key: o.key, label: fill(o.label, vars), tradeoff: fill(o.tradeoff, {...vars, cost: coin(c)}), cost: c, effects};
  };
  return makeCard(state, {
    kind: cardKind(state, body, t), from: body.id, templateId: t.id, category: t.category,
    title: t.work === 'bridge-upgrade' ? `The ${work?.where ?? 'old'} bridge is ${bridgeLoad(work) >= 1 ? 'too small' : 'worn'}`
      : work?.title ?? (body.centreId != null ? `${t.title}: ${vars.centre}` : t.title),
    why: t.work === 'bridge-upgrade' ? fill(t.why, vars) : work?.why ?? fill(t.why, vars), asker: body.asker,
    urgency: choice.need > 0.7 ? 2 : choice.need > 0.45 ? 1 : 0,
    cost, helps: t.helps ?? helpsFor(body), hurts: t.hurts ?? [],
    data: {workId: work?.id ?? null, need: choice.need, body: name, x: work?.x, z: work?.z,
      ...(basic ? {demand: bridgeDemand(work)} : {}),
      ...(t.work === 'bridge-upgrade' && work ? {demand: Math.max(bridgeLoad(work), 1 - (work.condition ?? 1)), work: {...work}} : {}),
      ...(basic && work ? {work: {id: work.id, key: work.key, kind: work.kind, cells: work.cells, x: work.x, z: work.z, w: work.w, d: work.d,
        band: work.band, where: work.where, place: work.place, options: work.options}} : {})},
    options: offered(state, t)
      .filter((o) => !work?.options || t.work !== 'bridge-upgrade' || work.options.some((x) => x.key === o.effects?.find((e) => e.work)?.variant))
      .map(optionsFor),
    details: detailsFor(state, body, cost),
  });
}

// A body acts alone (an expired demand) at most once a decade.
export const SELF_ENACT_YEARS = 10;
export const maySelfEnact = (state, body) => state.time.year - (body.selfEnactedYear ?? -Infinity) >= SELF_ENACT_YEARS;
export function noteSelfEnacted(state, body) {
  body.selfEnactedYear = state.time.year;
}

// A strong body no longer asks: it demands (no Refuse; Negotiate instead),
// but at most once a decade; between demands it proposes like anyone else.
function cardKind(state, body, t) {
  if (t?.kind && t.kind !== 'demand') return t.kind;
  const due = state.time.year - (body.lastDemandYear ?? -Infinity) >= SELF_ENACT_YEARS;
  if (body.kind !== 'moot' && (t?.kind === 'demand' || body.power >= 0.7) && due) {
    body.lastDemandYear = state.time.year;
    if (!body.demanding) {
      body.demanding = true;
      addChronicle(state, fill(LINES.bodyDemands, {name: `The ${body.name}`}), 'line', {body: body.id});
    }
    return 'demand';
  }
  body.demanding = false;
  return 'proposal';
}

// A petition asked this body for action: draft soon, and favour that category.
// A repeat petition (boost 0.6) presses harder than a first one (0.35).
export function focusBody(state, bodyId, category, boost = 0.35) {
  const body = bodyOf(state, bodyId);
  if (!body || body.status !== 'active') return;
  body.focus = {category, until: monthIndex(state.time) + 12, boost};
  body.nextDraftMonth = Math.min(body.nextDraftMonth ?? Infinity, monthIndex(state.time) + 1);
}

const optionCost = (o, cost) => o.effects?.some((e) => e.spend === 'cost' || e.work) ? cost
  : o.effects?.some((e) => e.spend === 'half') ? Math.round(cost / 2)
  : o.effects?.find((e) => Number.isFinite(e.spend))?.spend ?? 0;

function helpsFor(body) {
  return INSTITUTIONS[body.kind]?.constituency?.trades ?? [];
}

function ruleCard(state, body, choice, facts) {
  const def = POLICIES[choice.policy];
  const level = levelOf(state, choice.policy);
  const next = level + 1;
  const upkeep = upkeepFor(state, choice.policy, next);
  const grain = againstGrain(state, choice.policy, next);
  const raising = level > 0;
  if (!raising) body.lastAdoptYear = state.time.year;
  const title = raising ? `${def.title}: ${def.levelNames[next - 1].toLowerCase()}` : def.title;
  const why = [def.pitch, factLine(state, body, facts)].filter(Boolean).join(' ');
  const options = [{
    key: 'do', label: raising ? `Raise it to ${def.levelNames[next - 1].toLowerCase()}` : `Bring in ${def.title.toLowerCase().replace(/^the /, 'the ')}`,
    tradeoff: def.tradeoff, cost: 0, upkeep, effects: [{policy: choice.policy, level: next}],
  }];
  if (!raising && def.maxLevel >= 2 && canAdopt(state, choice.policy, 2)) {
    options.push({key: 'more', label: `Go further: ${def.levelNames[1].toLowerCase()}`, tradeoff: 'A stronger effect. A bigger bill.',
      cost: 0, upkeep: upkeepFor(state, choice.policy, 2), effects: [{policy: choice.policy, level: 2}]});
  }
  if (def.oneOff && def.cost) {
    const cost = Math.round(def.cost * costScale(state));
    options[0].cost = cost;
    options[0].effects.unshift({spend: cost});
    if (def.building) options[0].effects.push({build: def.building});
  }
  return makeCard(state, {
    kind: cardKind(state, body, null), from: body.id, templateId: choice.id, category: def.category,
    title, why, asker: body.asker, urgency: choice.need > 0.7 ? 2 : choice.need > 0.45 ? 1 : 0,
    cost: options[0].cost, upkeep, againstGrain: grain.against,
    helps: def.helps ?? [], hurts: def.hurts ?? [],
    data: {policy: choice.policy, level: next, need: choice.need},
    options,
    details: [
      {label: 'Upkeep', value: upkeep ? `${coin(upkeep)} a year` : 'None'},
      ...(grain.against ? [{label: 'The town', value: 'Against the grain'}] : []),
      ...detailsFor(state, body, options[0].cost).slice(0, 2),
    ],
  });
}

function easeCard(state, body, choice) {
  const def = POLICIES[choice.policy];
  const t = TEMPLATES['ease-rule'];
  const level = levelOf(state, choice.policy);
  const vars = {rule: def.title.toLowerCase().replace(/^(an?|the) /, '')};
  const options = t.options
    .filter((o) => o.key !== 'do' || level > 1)
    .map((o) => ({key: o.key, label: o.label, tradeoff: o.tradeoff, cost: 0,
      effects: o.effects.map((e) => (e.policy === 'target' ? {...e, policy: choice.policy} : e))}));
  return makeCard(state, {
    kind: 'proposal', from: body.id, templateId: choice.id, category: def.category,
    title: `Ease ${def.title.toLowerCase().replace(/^an? /, 'the ')}`.replace('the the', 'the'),
    why: fill(t.why, vars), asker: body.asker, urgency: 0, cost: 0,
    helps: def.hurts ?? [], hurts: def.helps ?? [],
    data: {policy: choice.policy, ease: true, need: choice.need},
    options,
  });
}

function factsFor(state, body, choice) {
  const I = state.indicators ?? {};
  return {
    people: count(I.pop ?? 0), months: count(Math.max(0, Math.round(I.foodBalance ?? 0))),
    farms: count(makeCtx(state).C.farm ?? 0), coin: coin(state.treasury ?? 0),
    count: count(10 + Math.round((I.pop ?? 0) / 60)),
    place: 'near the centre', percent: Math.round((I.literacy ?? 0) * 100),
  };
}


// One plain fact that says why now, by body.
function factLine(state, body, f) {
  const I = state.indicators ?? {};
  switch (body.kind) {
    case 'agri-council': return `Food stores last ${f.months} months.`;
    case 'health-board': return `About ${Math.round((1 - (state.pressures.health ?? 0)) * 10)} in ten people fall sick each year.`;
    case 'school-board': return `About ${Math.round((I.literacy ?? 0) * 10)} in ten people can read.`;
    case 'union': return `The richest families hold far more than the rest.`;
    case 'exchange': return `More boats come each year.`;
    case 'moot': return (state.treasury ?? 0) <= 0 ? 'The coffers are empty.' : (state.treasury ?? 0) < 300 ? `We have only ${f.coin}.` : '';
    default: return '';
  }
}

function detailsFor(state, body, cost) {
  const rows = [];
  if (cost) rows.push({label: 'Cost', value: coin(cost)});
  rows.push({label: 'Town coin', value: coin(state.treasury ?? 0)});
  if (body.kind !== 'moot') rows.push({label: `${body.name} purse`, value: coin(body.funds ?? 0)});
  return rows.slice(0, 4);
}

// ---------------------------------------------------------------------------
// Monthly and yearly
// ---------------------------------------------------------------------------

export function institutionsMonthly(state) {
  const m = monthIndex(state.time);
  const ctx = makeCtx(state);
  governanceCounts(state, ctx);
  const petitionBoost = (levelOf(state, 'open-moot') ? 1.5 : 1);
  wardPetitions(state);
  for (const kind of BODY_IDS) {
    if (kind === 'moot' || kind === 'ward' || !canPetition(state, kind)) continue;
    const def = INSTITUTIONS[kind];
    if (!holds(def.when, ctx)) continue;
    if (rng(state) < (def.chance ?? 1) * petitionBoost) addCard(state, petitionCard(state, kind));
  }
  // Waning bodies that lost heart offer one plea for a fresh start.
  for (const body of state.institutions) {
    if (body.status === 'waning' && !body.pleaded && state.time.year - body.waningSince >= 1) {
      body.pleaded = true;
      addCard(state, pleaCard(state, body));
    }
  }
  bridgeWatch(state);
  if (m % 3 === 0) sampleMetrics(state);
}

function pleaCard(state, body) {
  const cost = Math.round(200 * costScale(state));
  return makeCard(state, {
    kind: 'petition', from: body.id, templateId: 'revive', category: 'civic',
    title: `The ${body.name} has lost heart`,
    why: `The ${body.name} feels ignored. Its members stopped coming. It can still be saved.`,
    asker: body.asker, urgency: 1, cost,
    data: {revive: body.id},
    options: [
      {key: 'do', label: 'Give it a fresh start', tradeoff: `It costs ${coin(cost)}. Its patience returns.`, cost, effects: [{spend: cost}, {revive: body.id}]},
      {key: 'not_now', label: 'Let it fade', tradeoff: 'It will close within a few years.', effects: []},
    ],
  });
}

export function sampleMetrics(state) {
  for (const body of liveBodies(state)) {
    if (body.status === 'waning') continue;
    const def = INSTITUTIONS[body.kind];
    for (const mid of (def.metrics ?? []).slice(0, 6)) {
      const series = (body.metrics[mid] ??= []);
      series.push(METRICS[mid]?.read(state, body) ?? 0);
      if (series.length > 60) series.splice(0, series.length - 60);
    }
  }
}

export function institutionsYearly(state) {
  const year = state.time.year;
  balancePurses(state);
  const ctx = makeCtx(state);
  governanceCounts(state, ctx);
  let budgets = 0;
  const byBody = {};
  for (const body of state.institutions) {
    if (body.status === 'dissolved') continue;
    const oldName = body.name;
    body.name = bodyName(state, body.kind, body);
    if (oldName !== body.name) addChronicle(state, fill(LINES.bodyRenamed, {old: oldName, name: body.name}), 'line', {body: body.id});
    body.power = computePower(state, body);
    if (body.status === 'active') {
      body.patience = Math.min(1, body.patience + 0.1);
      // The economy pays each purse in; a body spends part of it on its own
      // work every year (clerks, tools, small repairs), so coin keeps moving.
      const running = Math.round((body.funds ?? 0) * RUNNING_SHARE);
      const spent = running > 0 ? payBuilders(state, `body:${body.id}`, running, 'bodies') : 0;
      body.spentThisYear = spent;
      budgets += spent;
      byBody[body.id] = spent;
      // Decline: the conditions that made the body are gone for long enough.
      const def = INSTITUTIONS[body.kind];
      if (def.declines && holds(def.declines, ctx)) {
        body.declineSince ??= year;
        if (year - body.declineSince >= (def.declineYears ?? 5) && !def.declineSoft) startWaning(state, body);
      } else {
        body.declineSince = null;
      }
      if (body.patience <= 0.001) startWaning(state, body);
    } else if (body.status === 'waning' && year - body.waningSince >= 5) {
      endBody(state, body, LINES.bodyDissolved);
    }
    if (body.delegated && body.report?.length) {
      addCard(state, reportCard(state, body));
      body.report = [];
    }
  }
  return {total: budgets, byBody};
}

export function startWaning(state, body) {
  if (body.status !== 'active' || body.kind === 'moot') return;
  body.status = 'waning';
  body.waningSince = state.time.year;
  body.delegated = false;
  body.pleaded = false;
  addChronicle(state, fill(LINES.bodyWaning, {name: `The ${body.name}`}), 'line', {body: body.id});
  invalidateCtx(state);
}

export function reviveBody(state, bodyId) {
  const body = bodyOf(state, bodyId);
  if (!body || body.status !== 'waning') return;
  body.status = 'active';
  body.patience = 0.6;
  body.waningSince = null;
  body.declineSince = null;
  body.nextDraftMonth = monthIndex(state.time) + 2;
  invalidateCtx(state);
}

function reportCard(state, body) {
  const lines = body.report.slice(0, 4);
  return makeCard(state, {
    kind: 'report', from: body.id, templateId: 'report', category: 'civic',
    title: `The ${body.name} reports`,
    why: lines.join(' '),
    asker: body.asker, urgency: 0, cost: 0,
    options: [{key: 'ok', label: 'Noted', tradeoff: 'They carry on as before.', effects: []}],
  });
}

// Patience changes from rulings and expiry.
export function notePatience(state, bodyId, change) {
  const body = bodyOf(state, bodyId);
  if (!body || body.kind === 'moot') return;
  body.patience = Math.max(0, Math.min(1, body.patience + change));
  if (body.patience <= 0.001) startWaning(state, body);
}

// For the decision model: a compact view of the body's own ledger.
export function bodyFacts(state, body) {
  const def = INSTITUTIONS[body.kind];
  const metrics = {};
  for (const mid of (def.metrics ?? []).slice(0, 4)) metrics[mid] = METRICS[mid]?.read(state) ?? 0;
  const last = state.cardHistory.filter((h) => h.from === body.id).slice(-3).map((h) => h.outcome ?? h.choice);
  return {metrics, lastRulings: last};
}

export const bodyColor = (state, id) => INSTITUTIONS[bodyOf(state, id)?.kind ?? id]?.color ?? null;

// The body's seat: a building it raised (its variant), else the first of its
// seat types, else the moot hall.
export function bodySeat(state, id) {
  const body = bodyOf(state, id);
  const def = INSTITUTIONS[body?.kind ?? id];
  if (!def) return null;
  const own = state.buildings.find((b) => b.raisedBy === (body?.id ?? id));
  if (own) return own;
  for (const type of def.seat ?? []) {
    const b = state.buildings.find((x) => x.type === type && (x.built ?? 1) >= 1);
    if (b) return b;
  }
  return state.buildings.find((x) => x.type === 'moot') ?? null;
}

// ---------------------------------------------------------------------------
// Centres (design-centres §4): ward councils, autonomy, merge / federate / stay apart
// ---------------------------------------------------------------------------

const liveCentres = (state) => (state.centres ?? []).filter((c) => c.mergedInto == null);
export const centreName = (state, id) => (state.centres ?? []).find((c) => c.id === id)?.name ?? 'The ward';
export const wardOf = (state, centreId) => state.institutions.find((b) => b.kind === 'ward' && b.centreId === centreId) ?? null;

// A centre other than the seat asks for its own council at ~600 people, or
// ~300 when it has a character of its own.
export const WARD_POP = 600;
function wardPetitions(state) {
  const [seat, ...others] = liveCentres(state);
  if (!seat) return;
  for (const c of others) {
    const pop = c.monthly?.pop ?? c.pop ?? 0;
    const own = c.character && c.character !== seat.character;
    if (pop < (own ? WARD_POP / 2 : WARD_POP)) continue;
    const id = `ward:${c.id}`;
    const existing = wardOf(state, c.id);
    if (existing && existing.status !== 'dissolved') continue;
    if (state.tags[`refused:${id}`] != null && state.time.year - state.tags[`refused:${id}`] <= 15) continue;
    if ((state.governance.petitionWait[id] ?? -1) > monthIndex(state.time)) continue;
    if (state.docket.some((x) => x.data?.forms === id)) continue;
    if (rng(state) < 0.2) addCard(state, wardPetitionCard(state, c));
  }
}

function wardPetitionCard(state, c) {
  const def = INSTITUTIONS.ward;
  const vars = {centre: c.name};
  const name = `${c.name} Ward Council`;
  const purse = (share) => coin(Math.round(fiscalBase(state) * share));
  return makeCard(state, {
    kind: 'petition', from: 'moot', templateId: `form:ward:${c.id}`, category: 'civic',
    title: fill(def.petition.title, vars), why: fill(def.petition.why, vars),
    asker: askerFor(state, `ward:${c.id}`), urgency: 1, cost: 0, helps: [], hurts: [],
    data: {forms: `ward:${c.id}`, centreId: c.id},
    options: [
      {key: 'standard', label: `Form the ${name}`, tradeoff: `A fair purse: about ${purse(0.04)} a year.`, effects: [{form: `ward:${c.id}`, budget: 0.04}]},
      {key: 'small', label: 'Form it with a small purse', tradeoff: `About ${purse(0.02)} a year. It can do little alone.`, effects: [{form: `ward:${c.id}`, budget: 0.02}]},
      {key: 'not_now', label: 'Not now', tradeoff: 'They will ask again in three years.', effects: [{wait: 36}]},
      {key: 'refuse', label: 'Refuse', tradeoff: 'They will not ask again for fifteen years. The ward will resent it.', effects: [{refuseBody: `ward:${c.id}`}]},
    ],
  });
}

export function formWard(state, id, budgetShare = 0.04) {
  const centreId = Number(String(id).split(':')[1]);
  let body = state.institutions.find((b) => b.id === id);
  if (body && body.status !== 'dissolved') return body;
  if (body) state.institutions.splice(state.institutions.indexOf(body), 1);
  body = createBody(state, 'ward', budgetShare);
  Object.assign(body, {id, centreId, grantShare: budgetShare, asker: askerFor(state, id)});
  body.name = bodyName(state, 'ward', body);
  body.power = computePower(state, body);
  state.institutions.push(body);
  balancePurses(state);
  setTag(state, `formed:${id}`);
  invalidateCtx(state);
  addChronicle(state, fill(LINES.bodyFounded, {name: `The ${body.name}`}), 'moment', {body: id, founded: true, centreId});
  return body;
}

// Autonomy (0..1): its own council, market and rates, a character of its own, and its council's power.
export function updateAutonomy(state) {
  const [seat] = liveCentres(state);
  for (const c of liveCentres(state)) {
    if (c === seat) { c.autonomy = 0; continue; }
    const ward = wardOf(state, c.id);
    const live = ward?.status === 'active';
    c.autonomy = Math.round(Math.min(1,
      (live ? 0.3 : 0) + (state.tags[`ward-market:${c.id}`] != null ? 0.15 : 0) + (state.tags[`ward-rates:${c.id}`] != null ? 0.2 : 0) +
      (c.character && c.character !== seat?.character ? 0.15 : 0) + (live ? 0.2 * ward.power : 0) - (c.federated ? 0.05 : 0) +
      (state.tags[`hall-stayed:${c.id}`] != null ? 0.1 : 0)) * 100) / 100;
  }
}

// When another centre overtakes the seat (sim-world's tag 'centre-overtook:<id>'),
// the council faces where its hall should stand.
export function hallCard(state) {
  const centres = liveCentres(state);
  const [seat] = centres;
  for (const c of centres.slice(1)) {
    const tag = `centre-overtook:${c.id}`;
    if (state.tags[tag] == null || state.time.year - state.tags[tag] > 3) continue;
    if (state.tags[`hall-asked:${c.id}`] != null || state.docket.some((x) => x.data?.hallFor === c.id)) continue;
    setTag(state, `hall-asked:${c.id}`);
    const cost = Math.round(1800 * costScale(state));
    return addCard(state, makeCard(state, {
      kind: 'proposal', from: 'moot', templateId: `hall:${c.id}`, category: 'civic',
      title: 'Where should the town hall be?',
      why: `${c.name} has grown bigger than ${seat.name}. Its people say the council should sit with them.`,
      asker: bodyOf(state, 'moot').asker, urgency: 1, cost, helps: [], hurts: [],
      data: {hallFor: c.id},
      options: [
        {key: 'move', label: `Move the hall to ${c.name}`, tradeoff: `It costs ${coin(cost)}. ${seat.name} loses its old standing.`, cost,
          effects: [{spend: 'cost'}, {build: 'moot', variant: 'town-hall', at: `centre:${c.id}`}, {tag: `seat:${c.id}`}, {deltas: {prestige: 0.02}}]},
        {key: 'stay', label: `Keep it in ${seat.name}`, tradeoff: `No cost. ${c.name} feels slighted and grows bolder.`, cost: 0,
          effects: [{tag: `hall-stayed:${c.id}`}, {deltas: {unrest: 0.02}}]},
      ],
    }));
  }
  return null;
}

// From era 3: two centres grown into each other, or wards clashing often, face
// one choice: merge, federate, or stay apart.
export const UNION_POP = 800;

export function unionCard(state) {
  if ((state.era ?? 0) < 3) return null;
  const centres = liveCentres(state);
  const [seat] = centres;
  const popOf = (c) => c.monthly?.pop ?? c.pop ?? 0;
  for (const c of centres.slice(1)) {
    // Only between two real towns; small centres fold in quietly (sim-world).
    if (popOf(seat) < UNION_POP || popOf(c) < UNION_POP) continue;
    if (c.federated || state.tags[`apart:${c.id}`] != null && state.time.year - state.tags[`apart:${c.id}`] < 20) continue;
    if (state.docket.some((x) => x.data?.union === c.id)) continue;
    const gap = Math.hypot(c.x - seat.x, c.z - seat.z);
    const touching = gap < 40 + 2.2 * Math.sqrt(Math.max(0, seat.pop ?? 0)) + 2.2 * Math.sqrt(Math.max(0, c.pop ?? 0)) - 20;
    const clashes = state.cardHistory.filter((h) => h.kind === 'debate' && String(h.templateId).includes('ward-') && state.time.year - h.year <= 10).length;
    if (!touching && clashes < 3) continue;
    return addCard(state, makeCard(state, {
      kind: 'proposal', from: 'moot', templateId: `union:${c.id}`, category: 'civic',
      title: `${seat.name} and ${c.name}`,
      why: touching ? `${seat.name} and ${c.name} have grown into each other. Their councils argue over every street.`
        : `${seat.name} and ${c.name} quarrel at every turn. It is time to settle how they live together.`,
      asker: bodyOf(state, 'moot').asker, urgency: 1, cost: 0, helps: [], hurts: [],
      data: {union: c.id},
      options: [
        {key: 'merge', label: 'Merge into one town', tradeoff: `One council and one rate. ${c.name} loses its say and will grumble.`, effects: [{union: {centre: c.id, choice: 'merge'}}]},
        {key: 'federate', label: 'Form a federation', tradeoff: 'Each keeps its council. A regional council costs a little to run.', effects: [{union: {centre: c.id, choice: 'federate'}}]},
        {key: 'apart', label: 'Keep them apart', tradeoff: 'Nothing changes. The rivalry goes on.', effects: [{union: {centre: c.id, choice: 'apart'}}]},
      ],
    }));
  }
  return null;
}

export function settleUnion(state, centreId, choice) {
  const centres = liveCentres(state);
  const [seat] = centres;
  const c = centres.find((x) => x.id === centreId);
  if (!c || !seat) return;
  const ward = wardOf(state, c.id);
  if (choice === 'merge') {
    c.mergedInto = seat.id;
    c.autonomy = 0;
    if (ward && ward.status !== 'dissolved') endBody(state, ward, LINES.bodyDissolved);
    delta(state, 'prestige', 0.05, `merge:${c.id}`);
    delta(state, 'unrest', 0.03, `merge:${c.id}`);
    setTag(state, `merged:${c.id}`);
    addChronicle(state, `${c.name} and ${seat.name} are one town now.`, 'moment', {centreId: c.id, merged: true});
  } else if (choice === 'federate') {
    c.federated = true;
    seat.federated = true;
    setTag(state, `federated:${c.id}`);
    delta(state, 'prestige', 0.02, `federate:${c.id}`);
    addChronicle(state, `${seat.name} and ${c.name} join in a federation. Each keeps its own council.`, 'moment', {centreId: c.id, federated: true});
  } else {
    setTag(state, `apart:${c.id}`);
    addChronicle(state, `${c.name} stays apart from ${seat.name}. The rivalry goes on.`, 'line', {centreId: c.id});
  }
}

export const personaOf = (state, id) => bodyOf(state, id)?.asker ?? askerFor(state, id);

export const bodyTitle = (state, id) => `The ${bodyOf(state, id)?.name ?? bodyName(state, id)}`;

