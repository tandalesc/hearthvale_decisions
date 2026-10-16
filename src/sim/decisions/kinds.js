// The question kinds non-player actors ask the decision model (design-systems §5.4).
//
// Pure data, no imports: the server imports this file to validate requests.
// Field schemas use the same shape as src/decision-kinds.js `field` helpers:
//   {type: 'int'|'number'|'enum'|'text', min?, max?, values?, maxLength?, optional?}
//
// Each kind:
//   id            snake_case, unique
//   type          'choice' (default) | 'score' (criteria are a scale, lowest first)
//                 | 'noul' (yes/no, "yes" key first); see src/decision-kinds.js
//   criteria      option key -> short label (fixed; a question may narrow with `allowed`)
//   context       per-question fields (slice descriptors plus the actor's own facts)
//   state         which shared snapshot the question carries: SNAPSHOTS[kind.share]
//   share         'town' | 'district' | 'slice' | 'proposal' | 'individual'
//   slices        slice dimensions for population kinds (one question per value)
//   weights       pooling weight per slice dimension
//   cadence       base sweep interval in months (0 = on demand)
//   highStakes    ask individuals where slices disagree, whatever the group size
//   instructions(context, offered) -> plain text, at most about 40 words

const int = (min, max, optional = false) => ({type: 'int', min, max, optional});
const num = (min, max, optional = false) => ({type: 'number', min, max, optional});
const oneOf = (values, optional = false) => ({type: 'enum', values: [...values], optional});
const text = (maxLength, optional = false) => ({type: 'text', maxLength, optional});

export const TRADES = ['farm', 'craft', 'trade', 'labour', 'clerical', 'clergy', 'gentry', 'none'];
export const WEALTH = ['poor', 'middling', 'wealthy'];
export const LIFE = ['young', 'family', 'elder'];
export const HOUSEHOLD_TYPES = ['single', 'couple', 'family', 'kin'];
export const FACTION_IDS = ['farmers', 'crafters', 'merchants', 'labourers', 'clergy', 'scholars', 'gentry', 'newcomers'];
export const FAITH = ['low', 'mid', 'high'];
export const YES_NO = ['yes', 'no'];
export const ERA_KEYS = ['hamlet', 'village', 'town', 'borough', 'city', 'metropolis'];
export const ARCHETYPES = ['market-town', 'mill', 'port', 'garden', 'cathedral', 'commune', 'exchange', 'scholar'];
export const BODY_KINDS = ['moot', 'agri-council', 'trades-guild', 'exchange', 'river-authority', 'school-board',
  'parish', 'health-board', 'planning', 'union', 'watch', 'arts-society', 'ward'];
export const CATEGORIES = ['land', 'labour', 'trade', 'tax', 'food', 'health', 'education', 'faith',
  'environment', 'infrastructure', 'civic', 'event'];
export const MOODS = ['angry', 'uneasy', 'content', 'glad'];
export const GRIEVANCES = ['housing', 'food', 'wages', 'roads', 'flood', 'health', 'faith', 'schooling', 'tolls', 'crime', 'eyesores', 'none'];
export const LOOKS = ['shabby', 'plain', 'pleasant'];

// Slice dimensions: how a population is cut. Values are what goes in context.
export const SLICE_DIMS = {
  district: null, // district names, from the town
  centre: null,   // centre (town) names in the valley
  trade: TRADES,
  wealthBand: WEALTH,
  lifeStage: LIFE,
  householdType: HOUSEHOLD_TYPES,
  faction: FACTION_IDS,
  newcomer: YES_NO,
  faithBand: FAITH,
};

// Optional slice descriptor fields every population kind accepts.
const SLICE_FIELDS = {
  district: text(24, true),
  centre: text(24, true),
  trade: oneOf(TRADES, true),
  wealthBand: oneOf(WEALTH, true),
  lifeStage: oneOf(LIFE, true),
  householdType: oneOf(HOUSEHOLD_TYPES, true),
  faction: oneOf(FACTION_IDS, true),
  newcomer: oneOf(YES_NO, true),
  faithBand: oneOf(FAITH, true),
  group: int(1, 100000, true), // people in the group (individual questions omit it)
};

// ---------------------------------------------------------------------------
// Shared snapshots (the request `state`). Bands only for shared ones, so the
// service cache sees byte-identical states between sweeps.
// ---------------------------------------------------------------------------

const TOWN = {
  era: oneOf(ERA_KEYS),
  season: oneOf(['spring', 'summer', 'autumn', 'winter']),
  archetype: oneOf(ARCHETYPES),
  food: oneOf(['low', 'ok', 'plenty']),
  coin: oneOf(['debt', 'tight', 'ok', 'rich']),
  wellbeing: oneOf(['poor', 'fair', 'good']),
  jobs: oneOf(['scarce', 'balanced', 'plenty']),
  homes: oneOf(['scarce', 'balanced', 'plenty']),
  health: oneOf(['poor', 'fair', 'good']),
  unrest: oneOf(['calm', 'uneasy', 'angry']),
  faith: oneOf(['low', 'mid', 'high']),
  river: oneOf(['quiet', 'busy', 'thronged']),
  taxStep: int(0, 6),
  rules: text(480),   // sorted active rule ids, 'tithe 2' when level > 1, comma separated
  recent: text(120),  // tags of the last three years, sorted, at most four
  bodies: text(240),  // sorted active body ids
  looks: oneOf(LOOKS, true),  // how the streets look (aesthetics.js); a district snapshot gives its own
};

// District-sliced questions carry a district snapshot; the same kind's other
// slices carry the plain town snapshot, so the district fields are optional.
const DISTRICT = {
  ...TOWN,
  districtName: text(24, true),
  character: oneOf(['farms', 'mill', 'market', 'quays', 'garden', 'old-town', 'new-quarter', 'slum'], true),
  rent: oneOf(['low', 'mid', 'high'], true),
  roads: oneOf(['paths', 'tracks', 'roads', 'paved'], true),
  crowding: oneOf(['loose', 'snug', 'packed'], true),
  nearRiver: oneOf(YES_NO, true),
  kin: oneOf(['few', 'some', 'many'], true),
};

const PROPOSAL = {
  ...TOWN,
  proposalId: text(40),
  proposalFrom: oneOf(BODY_KINDS),
  category: oneOf(CATEGORIES),
  summary: text(160),
  costBand: oneOf(['none', 'low', 'mid', 'high']),
  helps: text(80),
  hurts: text(80),
};

// A body's own ledger: asked once, so exact numbers are fine.
const BODY = {
  ...TOWN,
  body: oneOf(BODY_KINDS),
  year: int(0, 200),
  budget: num(0, 1e9),
  spent: num(0, 1e9),
  patience: num(0, 1),
  power: num(0, 1),
  metrics: text(200),
  lastRulings: text(80),
  rivalsLive: text(80),
};

export const SNAPSHOTS = {town: TOWN, district: DISTRICT, proposal: PROPOSAL, individual: BODY, slice: DISTRICT};

// ---------------------------------------------------------------------------
// Instructions helpers
// ---------------------------------------------------------------------------

const OWN = 'This is their own choice. The council decides the rules.';

function who(c, noun = 'People') {
  const bits = [];
  if (c.lifeStage) bits.push({young: 'young', family: 'with families', elder: 'elderly'}[c.lifeStage]);
  if (c.wealthBand) bits.push(c.wealthBand);
  if (c.trade) bits.push(c.trade === 'none' ? 'without a trade' : `in ${c.trade}`);
  if (c.faction) bits.push(`among the ${c.faction}`);
  if (c.householdType) bits.push(`${c.householdType} households`);
  if (c.newcomer) bits.push(c.newcomer === 'yes' ? 'newly arrived' : 'long settled');
  if (c.faithBand) bits.push(`of ${c.faithBand} faith`);
  if (c.district) bits.push(`in ${c.district}`);
  if (c.centre && !c.district) bits.push(`in ${c.centre}`);
  return bits.length ? `${noun} ${bits.join(', ')}` : noun;
}

const size = (c) => (c.group ? ` (${c.group} people)` : '');

// ---------------------------------------------------------------------------
// The kinds
// ---------------------------------------------------------------------------

export const KINDS = [
  {
    id: 'resident_routine', share: 'district', slices: ['district', 'lifeStage'], weights: {district: 0.5, lifeStage: 0.4}, cadence: 1,
    criteria: {
      work: 'Go to work.', rest: 'Rest at home.', shop: 'Shop at the market.',
      leisure: 'Spend time outdoors or with friends.', worship: 'Go to the chapel.', gather: 'Join the crowd at a gathering.',
    },
    context: {...SLICE_FIELDS, timeOfDay: oneOf(['morning', 'midday', 'evening']),
      energy: oneOf(['low', 'ok', 'high'], true), fullness: oneOf(['low', 'ok', 'high'], true), social: oneOf(['low', 'ok', 'high'], true)},
    instructions: (c) => `${who(c)}${size(c)} choose what to do this ${c.timeOfDay}. Needs: energy ${c.energy ?? 'mixed'}, food ${c.fullness ?? 'mixed'}, company ${c.social ?? 'mixed'}. ${OWN}`,
  },
  {
    id: 'household_stay_move', share: 'district', slices: ['district', 'trade', 'wealthBand', 'newcomer', 'centre'],
    weights: {district: 0.4, trade: 0.3, wealthBand: 0.3, newcomer: 0.3, centre: 0.3}, cadence: 12, highStakes: true,
    criteria: {stay: 'Stay in their home.', move_within: 'Move to another part of town.', emigrate: 'Leave Hearthvale.', bring_kin: 'Bring relatives to live here.',
      move_to_centre: 'Move to another town in the valley.'},
    context: {...SLICE_FIELDS, rentShare: num(0, 10, true), vacancy: oneOf(['none', 'few', 'many'], true), kinLeft: oneOf(YES_NO, true),
      otherTowns: oneOf(['none', 'some'], true)},
    instructions: (c) => `${who(c, 'Households')}${size(c)} decide whether to stay, move, leave or bring kin. ` +
      `${c.rentShare !== undefined ? `Rent takes ${Math.round(c.rentShare * 100)} in 100 of their savings. ` : ''}Most stay unless something is wrong. ${OWN}`,
  },
  {
    id: 'choose_trade', share: 'town', slices: ['district', 'trade', 'wealthBand'], weights: {district: 0.3, trade: 0.5, wealthBand: 0.3}, cadence: 12,
    criteria: {farm: 'Work the land.', craft: 'Learn a craft.', trade: 'Go into trade.', labour: 'Take labouring work.',
      clerical: 'Become a clerk or teacher.', clergy: 'Join the clergy.', leave_town: 'Seek work in another town.'},
    context: {...SLICE_FIELDS, literacy: oneOf(['none', 'some', 'good'], true), openJobs: text(80, true)},
    instructions: (c) => `Young people from families ${who(c, '').trim() || 'in town'}${size(c)} choose a trade. ` +
      `${c.openJobs ? `Open jobs: ${c.openJobs}. ` : ''}${c.literacy ? `Reading: ${c.literacy}. ` : ''}${OWN}`,
  },
  {
    id: 'react_to_policy', share: 'proposal', slices: ['trade', 'wealthBand', 'district', 'centre'], weights: {trade: 0.5, wealthBand: 0.3, district: 0.3, centre: 0.3}, cadence: 0,
    criteria: {support: 'Welcome it.', accept: 'Accept it quietly.', grumble: 'Grumble about it.', protest: 'Protest in the street.',
      strike: 'Stop work in protest.', leave: 'Leave town over it.'},
    context: {...SLICE_FIELDS, change: oneOf(['adopted', 'raised', 'lowered', 'repealed']), rule: text(40)},
    instructions: (c) => `The council ${c.change} a rule: ${c.rule}. ${who(c)}${size(c)} react. Strikes are only for workers. Most people accept small changes. ${OWN}`,
  },
  {
    id: 'faction_stance', share: 'proposal', slices: ['faction'], weights: {faction: 1}, cadence: 0,
    criteria: {for: 'Back the proposal.', against: 'Oppose the proposal.', split: 'Be divided over it.', indifferent: 'Not care much.'},
    context: {...SLICE_FIELDS, mood: oneOf(MOODS), sizeBand: oneOf(['small', 'mid', 'large']), side: oneOf(['helps', 'hurts', 'neutral'])},
    instructions: (c) => `The ${c.faction} (mood ${c.mood}, a ${c.sizeBand} group) weigh the proposal. It ${c.side === 'neutral' ? 'barely touches them' : `${c.side} them`}. Say where they stand. ${OWN}`,
  },
  {
    id: 'institution_form_support', share: 'proposal', slices: ['faction'], weights: {faction: 1}, cadence: 0,
    criteria: {back: 'Back the new body.', oppose: 'Oppose the new body.', indifferent: 'Not care much.'},
    context: {...SLICE_FIELDS, mood: oneOf(MOODS), sizeBand: oneOf(['small', 'mid', 'large']), body: oneOf(BODY_KINDS)},
    instructions: (c) => `A new body, the ${c.body}, asks to form. The ${c.faction} (mood ${c.mood}, a ${c.sizeBand} group) decide whether to back it. ${OWN}`,
  },
  {
    id: 'petition', share: 'town', slices: ['faction'], weights: {faction: 1}, cadence: 6,
    criteria: {wait: 'Wait and see.', petition_moot: 'Petition the council.', petition_body: 'Petition their own body.',
      gather: 'Gather at the hall to be heard.', leave: 'Give up and think of leaving.'},
    context: {...SLICE_FIELDS, mood: oneOf(MOODS), grievance: oneOf(GRIEVANCES), hasBody: oneOf(YES_NO)},
    instructions: (c) => `The ${c.faction}${size(c)} are ${c.mood}. Their main complaint is ${c.grievance}. They ${c.hasBody === 'yes' ? 'have' : 'have no'} body of their own. What do they do? ${OWN}`,
  },
  {
    id: 'where_to_settle', share: 'town', slices: [], weights: {}, cadence: 0,
    criteria: {d1: 'Settle in the first district.', d2: 'Settle in the second district.', d3: 'Settle in the third district.',
      d4: 'Settle in the fourth district.', pass_by: 'Move on to another town.'},
    context: {migrant: oneOf(['poor_family', 'craftsman', 'merchant']), d1: text(80), d2: text(80, true), d3: text(80, true), d4: text(80, true)},
    instructions: (c) => `A ${c.migrant.replace('_', ' ')} arrives. Districts: first ${c.d1}` +
      `${c.d2 ? `; second ${c.d2}` : ''}${c.d3 ? `; third ${c.d3}` : ''}${c.d4 ? `; fourth ${c.d4}` : ''}. Where do they settle? ${OWN}`,
  },
  {
    id: 'festival_participation', share: 'district', slices: ['district', 'faithBand'], weights: {district: 0.4, faithBand: 0.6}, cadence: 0,
    criteria: {join: 'Join in.', watch: 'Watch from the side.', ignore: 'Stay away.', protest: 'Protest against it.'},
    context: {...SLICE_FIELDS, event: oneOf(['fair', 'feast', 'jubilee', 'carnival'])},
    instructions: (c) => `There is a ${c.event} in town. ${who(c)}${size(c)} decide whether to take part. ${OWN}`,
  },
  {
    id: 'crime_charity', share: 'district', slices: ['wealthBand', 'district', 'newcomer'], weights: {wealthBand: 0.5, district: 0.3, newcomer: 0.3}, cadence: 12,
    criteria: {honest: 'Live honestly.', petty_theft: 'Steal a little to get by.', join_gang: 'Join a gang.',
      seek_alms: 'Ask for alms.', give_alms: 'Give alms to the poor.'},
    context: {...SLICE_FIELDS, watch: oneOf(YES_NO), alms: oneOf(YES_NO)},
    instructions: (c) => `${who(c, 'Households')}${size(c)} get by as they can. The watch is ${c.watch === 'yes' ? 'about' : 'absent'}. Alms are ${c.alms === 'yes' ? 'on offer' : 'scarce'}. Most live honestly. ${OWN}`,
  },
  {
    id: 'event_response', share: 'district', slices: ['district', 'wealthBand', 'faithBand'], weights: {district: 0.4, wealthBand: 0.3, faithBand: 0.3}, cadence: 0, highStakes: true,
    criteria: {help: 'Help their neighbours.', flee: 'Flee to safety.', hoard: 'Hoard food and goods.', pray: 'Pray for deliverance.', blame_council: 'Blame the council.'},
    context: {...SLICE_FIELDS, event: oneOf(['flood', 'fire', 'plague', 'riot', 'blight', 'drought', 'bust', 'strike'])},
    instructions: (c) => `A ${c.event} strikes Hearthvale. ${who(c)}${size(c)} respond. ${OWN}`,
  },
  {
    id: 'strike_vote', share: 'proposal', slices: ['district', 'wealthBand'], weights: {district: 0.5, wealthBand: 0.5}, cadence: 0, highStakes: true,
    criteria: {strike: 'Join the strike.', work: 'Keep working.', partial: 'Work short hours in support.'},
    context: {...SLICE_FIELDS, wages: oneOf(['low', 'fair', 'good'])},
    instructions: (c) => `The union calls a strike. ${who(c, 'Workers')}${size(c)} vote. Wages are ${c.wages}. ${OWN}`,
  },
  {
    id: 'newcomer_integrate', share: 'district', slices: ['district', 'trade'], weights: {district: 0.5, trade: 0.5}, cadence: 12,
    criteria: {assimilate: 'Mix with the town.', cluster: 'Keep to their own quarter.', move_on: 'Move on elsewhere.'},
    context: {...SLICE_FIELDS},
    instructions: (c) => `${who(c, 'Newcomer households')}${size(c)} decide how to settle in. ${OWN}`,
  },
  {
    id: 'enterprise_plan', share: 'town', slices: [], weights: {}, cadence: 12,
    criteria: {hold: 'Carry on as now.', expand: 'Expand the business.', automate: 'Buy machines and need fewer hands.',
      diversify: 'Try a different line of work.', close: 'Close the business.', relocate: 'Move to a cheaper site.',
      sell_site: 'Sell the site and stop.', downsize: 'Shrink to a smaller place.'},
    context: {type: text(20), jobs: int(0, 10000), cash: num(-1e9, 1e9), profit: num(-1e9, 1e9),
      demand: oneOf(['low', 'mid', 'high']), labour: oneOf(['short', 'ok']), rules: text(80, true),
      rent: oneOf(['light', 'moderate', 'heavy', 'crushing'], true), siteOffer: oneOf(['none', 'fair', 'rich', 'huge'], true),
      cheaperSite: oneOf(['near', 'far', 'none'], true), landHungry: oneOf(YES_NO, true)},
    instructions: (c) => `A ${c.type} with ${c.jobs} workers plans its year. Cash ${Math.round(c.cash)}, profit last year ${Math.round(c.profit)}. ` +
      `Demand is ${c.demand}; hands are ${c.labour}.${c.rent ? ` Rent is ${c.rent}.` : ''}${c.siteOffer && c.siteOffer !== 'none' ? ` A buyer offers a ${c.siteOffer} price for the site.` : ''}` +
      `${c.cheaperSite ? ` Cheaper land: ${c.cheaperSite}.` : ''}${c.rules ? ` Rules: ${c.rules}.` : ''} It spends only its own money.`,
  },
  {
    id: 'enterprise_found', share: 'town', slices: [], weights: {}, cadence: 24,
    criteria: {none: 'Keep their savings.', farm: 'Start a farm.', workshop: 'Open a workshop.', shop: 'Open a shop.', inn: 'Open an inn.',
      mill: 'Build a mill.', warehouse: 'Build a warehouse.', school: 'Found a school.', chapel_donation: 'Give to the chapel.'},
    context: {savings: num(0, 1e9), shortGoods: text(60), riverTrade: oneOf(['low', 'mid', 'high'])},
    instructions: (c) => `A wealthy household has ${Math.round(c.savings)} coin saved. The town is short of ${c.shortGoods || 'nothing much'}. River trade is ${c.riverTrade}. What do they start? ${OWN}`,
  },
  {
    id: 'enterprise_type_for_site', share: 'town', slices: [], weights: {}, cadence: 0,
    criteria: {farm: 'Turn it into a farm.', workshop: 'Turn it into a workshop.', shop: 'Turn it into a shop.',
      inn: 'Turn it into an inn.', mill: 'Turn it into a mill.', warehouse: 'Turn it into a warehouse.'},
    context: {current: text(20), shortGoods: text(60)},
    instructions: (c) => `A ${c.current} wants a new line of work. The town is short of ${c.shortGoods || 'nothing much'}. What should it become?`,
  },
  {
    id: 'choose_site', share: 'district', slices: [], weights: {}, cadence: 0,
    criteria: {a: 'Build on site A.', b: 'Build on site B.', c: 'Build on site C.', d: 'Build on site D.', wait: 'Wait for a better site.'},
    context: {need: text(20), a: text(80), b: text(80, true), c: text(80, true), d: text(80, true)},
    instructions: (c) => `A builder looks for a site for a ${c.need}. A: ${c.a}.${c.b ? ` B: ${c.b}.` : ''}${c.c ? ` C: ${c.c}.` : ''}${c.d ? ` D: ${c.d}.` : ''} Which suits best?`,
  },
  {
    // A scale, lowest first: the model rates net migration instead of picking
    // freely, which keeps it from backing exodus and wave at once.
    id: 'migration_wave', type: 'score', share: 'town', slices: [], weights: {}, cadence: 12,
    criteria: {exodus_pull: 'People are drawn away.', none: 'Few people come or go.', trickle: 'A trickle of newcomers.', wave: 'A wave of newcomers.'},
    context: {prestige: oneOf(['low', 'mid', 'high']), recent: text(60), neighbours: oneOf(['quiet', 'troubled'])},
    instructions: (c) => `The wider world looks at Hearthvale. Its name is ${c.prestige}. Lately: ${c.recent || 'nothing much'}. Neighbouring towns are ${c.neighbours}. How many people move here this year?`,
  },
  {
    id: 'merchant_speculate', share: 'district', slices: ['district'], weights: {district: 1}, cadence: 12,
    criteria: {invest_build: 'Invest in new buildings.', invest_trade: 'Invest in cargo and trade.', hoard: 'Hold on to their coin.', lend_to_town: 'Lend to the town.'},
    context: {...SLICE_FIELDS, mood: oneOf(MOODS)},
    instructions: (c) => `Wealthy merchants${c.district ? ` in ${c.district}` : ''} decide what to do with their coin. Their mood is ${c.mood}. ${OWN}`,
  },
  {
    id: 'institution_draft', share: 'individual', slices: [], weights: {}, cadence: 6,
    criteria: {p1: 'Bring the first plan.', p2: 'Bring the second plan.', p3: 'Bring the third plan.', p4: 'Bring the fourth plan.',
      p5: 'Bring the fifth plan.', p6: 'Bring the sixth plan.', none: 'Bring no plan this season.'},
    context: {body: oneOf(BODY_KINDS), p1: text(60), p2: text(60, true), p3: text(60, true), p4: text(60, true), p5: text(60, true), p6: text(60, true),
      n1: int(0, 3, true), n2: int(0, 3, true), n3: int(0, 3, true), n4: int(0, 3, true), n5: int(0, 3, true), n6: int(0, 3, true)},
    instructions: (c) => `The ${c.body} drafts a plan for the council. Plans: ${['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].filter((k) => c[k]).map((k, i) => `${i + 1} ${c[k]}`).join('; ')}. ` +
      'Pick the one its ledger needs most. The council rules on it.',
  },
  {
    id: 'institution_negotiate', share: 'individual', slices: [], weights: {}, cadence: 0,
    criteria: {accept_half: 'Accept half of what they asked.', insist: 'Insist on the full demand.', withdraw: 'Withdraw the demand.'},
    context: {body: oneOf(BODY_KINDS), power: num(0, 1), patience: num(0, 1), ask: num(0, 1e9), offer: num(0, 1e9)},
    instructions: (c) => `The council offers the ${c.body} half of its demand. Its power is ${c.power.toFixed(2)}, its patience ${c.patience.toFixed(2)}. Does it take the offer?`,
  },
  {
    id: 'household_home', share: 'town', slices: ['trade', 'wealthBand'], weights: {trade: 0.5, wealthBand: 0.5}, cadence: 12,
    criteria: {keep: 'Keep the home as it is.', repair: 'Repair the home.', extend: 'Add a storey or a room.',
      rebuild_up: 'Rebuild the home bigger and better.', buy_second: 'Buy a second home.'},
    context: {...SLICE_FIELDS, savings: num(0, 1e9, true), income: num(-1e9, 1e9, true), rent: num(0, 1e6, true), homeTier: int(1, 5, true),
      condition: num(0, 1, true), canExtend: oneOf(YES_NO, true), neighboursTier: num(1, 5, true), eraMaxTier: int(1, 5, true), nextCost: num(0, 1e9, true)},
    instructions: (c) => (c.savings !== undefined
      ? `A household with ${Math.round(c.savings)} coin saved lives in a tier ${c.homeTier} home in ${Math.round((c.condition ?? 1) * 100)} in 100 repair. A better home costs ${Math.round(c.nextCost ?? 0)}. Neighbours average tier ${(c.neighboursTier ?? 1).toFixed(1)}. ${OWN}`
      : `${who(c, 'Households')}${size(c)} think about their homes this year. ${OWN}`),
  },
  {
    id: 'farm_land', share: 'district', slices: [], weights: {}, cadence: 0,
    criteria: {keep: 'Keep farming the land.', sell_some_plots: 'Sell the fields nearest town.', sell_all_and_move_out: 'Sell it all and farm further out.'},
    context: {landValue: oneOf(['rising', 'high', 'very_high']), profit: oneOf(['loss', 'thin', 'good']), valueRatio: oneOf(['low', 'mid', 'high', 'very_high']),
      ownerAge: oneOf(['young', 'family', 'elder'], true), wealthBand: oneOf(WEALTH, true), yearsFarmed: int(0, 300, true), agriCouncil: oneOf(YES_NO, true)},
    instructions: (c) => `A farming family near town weighs its land. Land value is ${c.landValue.replace('_', ' ')}; the farm's profit is ${c.profit}. ` +
      `The land is worth ${c.valueRatio.replace('_', ' ')} next to what it earns.${c.yearsFarmed !== undefined ? ` They have farmed it ${c.yearsFarmed} years.` : ''} ${OWN}`,
  },
  {
    // A scale of how hard they lean on credit, lowest first. The model reads
    // money in words far better than raw numbers, so the instructions band them.
    id: 'take_loan', type: 'score', share: 'town', slices: [], weights: {}, cadence: 24,
    criteria: {sell_up: 'Sell up and start over.', hold: 'Hold on and wait.', borrow_small: 'Borrow a little.', borrow_large: 'Borrow a lot.'},
    context: {who: oneOf(['household', 'enterprise']), cash: num(-1e9, 1e9), monthlyCost: num(0, 1e9), debt: num(0, 1e9), rate: oneOf(['low', 'mid', 'high']),
      losing: int(0, 10, true)},
    instructions: (c) => {
      const cost = Math.max(1, c.monthlyCost);
      const coin = c.cash <= 0 ? 'Its coin is gone and bills are due' : c.cash < 2 * cost ? 'It has a month or two of costs left' : 'It has some coin put by';
      const years = c.debt / (12 * cost);
      const owes = c.debt <= 0 ? 'It owes nothing.' : years < 1 ? 'It owes less than a year of costs.' : `It already owes ${years < 2 ? 'over a year' : `${Math.min(20, Math.floor(years))} years`} of costs.`;
      const rate = {low: 'cheap', mid: 'fairly priced', high: 'dear'}[c.rate];
      const trade = c.losing >= 2 ? ` Trade has been poor for ${c.losing} years.` : c.losing === 1 ? ' Trade was poor last year.' : '';
      return `A ${c.who === 'enterprise' ? 'business' : 'household'} is short of coin. ${coin}. ${owes} Borrowing is ${rate}.${trade} What does the owner do? ${OWN}`;
    },
  },
];

export const KIND_BY_ID = Object.fromEntries(KINDS.map((k) => [k.id, k]));
export const KIND_IDS = KINDS.map((k) => k.id);

// ---------------------------------------------------------------------------
// Validation (pure; the server may use these or its own registry)
// ---------------------------------------------------------------------------

const SAFE_TEXT = /^[A-Za-z0-9 _,.\/-]*$/;

export function checkField(schema, value) {
  switch (schema.type) {
    case 'int': return Number.isSafeInteger(value) && value >= schema.min && value <= schema.max;
    case 'number': return Number.isFinite(value) && value >= schema.min && value <= schema.max;
    case 'enum': return typeof value === 'string' && schema.values.includes(value);
    case 'text': return typeof value === 'string' && value.length <= schema.maxLength && SAFE_TEXT.test(value);
    default: return false;
  }
}

// -> null when valid, else a short reason.
export function checkFields(schemas, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return 'not an object';
  for (const name of Object.keys(values)) if (!(name in schemas)) return `unknown field ${name}`;
  for (const [name, schema] of Object.entries(schemas)) {
    const v = values[name];
    if (v === undefined) {
      if (!schema.optional) return `missing ${name}`;
      continue;
    }
    if (!checkField(schema, v)) return `bad ${name}`;
  }
  return null;
}

export function validateContext(kindId, context) {
  const kind = KIND_BY_ID[kindId];
  if (!kind) return 'unknown kind';
  return checkFields(kind.context, context ?? {});
}

export function validateSnapshot(kindId, snapshot) {
  const kind = KIND_BY_ID[kindId];
  if (!kind) return 'unknown kind';
  return checkFields(SNAPSHOTS[kind.share], snapshot ?? {});
}

export const snapshotSchemaFor = (kindId) => SNAPSHOTS[KIND_BY_ID[kindId]?.share] ?? null;
