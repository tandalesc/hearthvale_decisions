// Content for the development stub. It mirrors the shapes of the real
// selectors (contract §5) so the UI can be built and tested on a rich
// late-game town before src/sim/view.js exists. Never used in production
// once the real modules are present.

export const FACTIONS = {
  farmers: 'Farmers', crafts: 'Craftsfolk', merchants: 'Merchants', millers: 'Millers',
  clergy: 'Clergy', labour: 'Labourers', newcomers: 'Newcomers', gentry: 'Gentry', scholars: 'Scholars',
};

export const BODY_DEFS = {
  moot: {
    name: ['Village Moot', 'Village Moot', 'Town Council', 'Town Council', 'City Council', 'City Council'],
    explainer: ['The Moot speaks for the whole town.', 'It brings you general matters: taxes, loans, festivals and new bodies.'],
    metrics: [['coin', 'Coin', '', 14200, 0.02], ['people', 'People', '', 28, 0.03], ['wellbeing', 'Wellbeing', '%', 72, 0]],
  },
  'agri-council': {
    name: 'Agricultural Council',
    explainer: ['The farmers have their own council now.', 'It tracks the harvest and brings you farm plans to rule on.'],
    metrics: [['farms', 'Farms', '', 14, 0.01], ['yield', 'Yield per farm', '', 38, 0.005], ['foodMonths', 'Food stored', ' mo', 7, -0.01], ['farmIncome', 'Farm income', '', 2400, 0.01]],
  },
  'trades-guild': {
    name: 'Trades Guild',
    explainer: ['The craftsfolk have formed a guild.', 'It watches the workshops and asks for rules that protect its trades.'],
    metrics: [['workshops', 'Workshops', '', 22, 0.01], ['goods', 'Goods made', '', 640, 0.02], ['apprentices', 'Apprentices', '', 48, 0.01]],
  },
  'river-authority': {
    name: 'River Authority',
    explainer: ['The River Authority looks after the water.', 'It plans bridges, quays and flood banks, and it counts who crosses where.'],
    metrics: [['crossings', 'Crossings a day', '', 412, 0.02], ['floodRisk', 'Flood risk', '%', 34, -0.01], ['quay', 'Quay length', ' m', 120, 0.01]],
  },
  parish: {
    name: 'The Parish',
    explainer: ['The parish has a voice at the table.', 'It cares for worship, alms and feast days.'],
    metrics: [['attendance', 'At worship', '%', 58, -0.005], ['tithe', 'Tithe', '', 380, 0], ['alms', 'Alms given', '', 90, 0.01]],
  },
  'school-board': {
    name: 'School Board',
    explainer: ['The School Board wants every child to read.', 'It tracks pupils and teachers and brings you plans for schools.'],
    metrics: [['literacy', 'Can read', '%', 41, 0.01], ['pupils', 'Pupils', '', 310, 0.02], ['schools', 'Schools', '', 4, 0.005]],
  },
  'health-board': {
    name: 'Health Board',
    explainer: ['The Health Board watches over the sick.', 'It plans wells, drains and an infirmary.'],
    metrics: [['sick', 'Sick this year', '%', 9, -0.01], ['wells', 'Wells', '', 11, 0.01], ['beds', 'Infirmary beds', '', 24, 0.01]],
  },
  planning: {
    name: 'Planning Office',
    explainer: ['The Planning Office reads the streets.', 'It sees where people walk and proposes roads, squares and bridges.'],
    metrics: [['paved', 'Paved streets', '', 180, 0.02], ['crossing', 'Crossing demand', '%', 62, 0.01], ['vacant', 'Empty lots', '', 37, -0.02]],
  },
  exchange: {
    name: 'Merchant Exchange',
    explainer: ['The merchants have opened an exchange.', 'It follows trade and prices, and it wants fewer limits on business.'],
    metrics: [['trade', 'Trade', '', 9200, 0.03], ['prices', 'Prices', '', 104, 0.005], ['merchantWealth', 'Merchant wealth', '', 520, 0.02]],
  },
  union: {
    name: "Workers' Union",
    explainer: ['The mill hands have formed a union.', 'It speaks for wages, hours and safety at work.'],
    metrics: [['wages', 'Wages', '', 31, 0.01], ['hours', 'Hours a week', '', 64, -0.005], ['strikes', 'Strike days', '', 6, 0]],
  },
  watch: {
    name: 'Town Watch',
    explainer: ['The Town Watch keeps the peace.', 'It asks for lamps, patrols and sometimes a curfew.'],
    metrics: [['crime', 'Crime', '%', 12, -0.01], ['patrols', 'Patrols', '', 9, 0.01], ['lamps', 'Lamps', '', 64, 0.02]],
  },
  'arts-society': {
    name: 'Festival & Arts Society',
    explainer: ['The arts society wants a livelier town.', 'It plans fairs, a theatre and things to be proud of.'],
    metrics: [['festivals', 'Festivals', '', 3, 0], ['visitors', 'Visitors', '', 840, 0.03]],
  },
};

// Rule Book catalogue (subset of design-systems §4) in plain words.
export const RULES = {
  commons: ['land', 'Common grazing', 'Anyone may graze animals on the commons.'],
  enclosure: ['land', 'Enclosure', 'Landowners may fence the open fields. Yields rise. Small farmers lose grazing.'],
  zoning: ['land', 'Zoning', 'The Planning Office sets how dense each district may be.'],
  'park-reserve': ['land', 'Park reserve', 'Some lots stay green for good.'],
  apprenticeship: ['labour', 'Apprenticeship rule', 'Young workers learn a trade under a master first.'],
  'wage-floor': ['labour', 'Wage floor', 'No one may be paid less than a set wage.'],
  'hours-cap': ['labour', 'Hours cap', 'Mills and workshops may not work people past a limit.'],
  'child-labour-ban': ['labour', 'No child labour', 'Children go to school, not to the mill.'],
  'market-charter': ['trade', 'Market charter', 'The town holds a weekly market by right.'],
  tolls: ['trade', 'River tolls', 'Boats pay to pass. It brings coin but fewer boats.'],
  'free-trade': ['trade', 'Free trade', 'No tolls and no price rules. Goods get cheaper.'],
  'price-floor': ['trade', 'Price floor', 'The guild sets the lowest price for its goods.'],
  'property-tax': ['tax', 'Property tax', 'Each household pays a share of its home value.'],
  'income-tax': ['tax', 'Income tax', 'Each household pays a share of what it earns.'],
  tithe: ['tax', 'Tithe', 'A tenth of the harvest goes to the parish.'],
  granary: ['food', 'Town granary', 'The town stores grain against a bad year.'],
  'grain-import': ['food', 'Grain imports', 'The town buys grain from downriver.'],
  'fast-days': ['food', 'Fast days', 'People eat less on holy days.'],
  wells: ['health', 'Public wells', 'Clean water in every district.'],
  sewers: ['health', 'Sewers', 'Drains carry waste away from the streets.'],
  quarantine: ['health', 'Quarantine', 'The sick stay home during an outbreak.'],
  'smoke-limits': ['health', 'Smoke limits', 'Mills must keep their smoke down.'],
  'parish-school': ['education', 'Parish school', 'The parish teaches children to read.'],
  'free-schooling': ['education', 'Free schooling', 'The town pays for every child to go to school.'],
  library: ['education', 'Public library', 'Books anyone may borrow.'],
  'press-licence': ['education', 'Printing licence', 'Presses may print news and pamphlets.'],
  'feast-days': ['culture', 'Feast days', 'Holy days off work, with a procession.'],
  'sabbath-rule': ['culture', 'Sabbath rule', 'Shops close one day a week.'],
  'festival-fund': ['culture', 'Festival fund', 'The town pays toward a summer fair.'],
  'riverbank-protect': ['environment', 'Riverbank care', 'Banks are planted and kept. Floods do less harm.'],
  'mill-rights': ['environment', 'Mill rights', 'Mills may take water from the river.'],
  'paving-fund': ['works', 'Paving fund', 'Each year the busiest paths get paved.'],
  lamps: ['works', 'Street lamps', 'Lamps light the main streets at night.'],
  drainage: ['works', 'Field drainage', 'Ditches drain the low fields.'],
  'open-moot': ['rights', 'Open moot', 'Anyone may bring a petition to the Moot.'],
  curfew: ['rights', 'Curfew', 'The streets close after dark.'],
  'guild-vote': ['rights', 'Guild vote', 'The guild gets a seat on the Council.'],
};

export const CATEGORIES = [
  ['land', 'Land'], ['food', 'Food'], ['tax', 'Tax'], ['labour', 'Work'], ['trade', 'Trade'],
  ['health', 'Health'], ['education', 'Learning'], ['culture', 'Faith and culture'],
  ['environment', 'River and land care'], ['works', 'Roads and works'], ['rights', 'Rights'],
];

export const TENSION_PAIRS = [
  ['wage-floor', 'free-trade', 'The wage floor raises pay. Free trade pushes it down.', ['labour'], ['merchants']],
  ['tithe', 'free-schooling', 'The tithe pays the parish to teach. Free schooling pays the town to teach.', ['clergy'], ['scholars', 'newcomers']],
  ['sabbath-rule', 'market-charter', 'The sabbath closes the shops. The charter wants the market open.', ['clergy'], ['merchants']],
  ['smoke-limits', 'mill-rights', 'Smoke limits slow the mills. Mill rights help them grow.', ['newcomers'], ['millers']],
  ['enclosure', 'commons', 'Enclosure fences the fields. The commons keep them open.', ['gentry'], ['farmers']],
];

// Docket cards. Options follow the language guide: verb phrase plus one
// trade-off sentence. Reactions: dir −2..2 per faction.
export const CARDS = [
  {
    id: 'c-cottages', kind: 'proposal', from: 'moot', era: 0, title: 'Room to put down roots',
    why: 'Young families are ready to settle. They want to build this spring, before the harvest.',
    asker: {name: 'Mara Hollin', role: 'Village steward'}, urgency: 1, costLine: 'Costs 2,040 coin. Homes for 18 people.',
    options: [
      {key: 'fund', label: 'Fund three cottages', tradeoff: 'The town pays. Families move in by summer.', cost: 2040, reactions: [{faction: 'newcomers', dir: 2}, {faction: 'farmers', dir: 1}, {faction: 'gentry', dir: -1}]},
      {key: 'households', label: 'Let households build', tradeoff: 'No cost to the town. Slower, and only the better-off can build.', cost: 0, reactions: [{faction: 'gentry', dir: 1}, {faction: 'newcomers', dir: -1}]},
      {key: 'later', label: 'Not now', tradeoff: 'The steward will ask again next year.', reactions: []},
    ],
    details: [{label: 'Families waiting', value: '3'}, {label: 'Homes free', value: '0'}, {label: 'Coin in the chest', value: '14,200'}],
    expiresInMonths: 18,
  },
  {
    id: 'c-bridge', kind: 'debate', from: 'river-authority', era: 2, title: 'A bridge at the mill ford',
    why: 'Many people cross at the mill ford. In spring it floods. A bridge would save time and lives.',
    asker: {name: 'Tamsin Ode', role: 'River warden'}, urgency: 2, costLine: 'Costs 1,600 coin. Upkeep 5 a year.',
    options: [
      {key: 'timber', label: 'Build in timber', tradeoff: 'Cheap. It will need replacing in sixty years.', cost: 600, reactions: [{faction: 'merchants', dir: 1}, {faction: 'farmers', dir: 1}, {faction: 'millers', dir: -1}]},
      {key: 'stone', label: 'Build in stone', tradeoff: 'Three times the cost. It lasts and looks fine.', cost: 1600, reactions: [{faction: 'merchants', dir: 2}, {faction: 'gentry', dir: 1}, {faction: 'millers', dir: -2}]},
      {key: 'ferry', label: 'License a ferry', tradeoff: 'No cost. Slower, and the ferryman takes a fee.', cost: 0, reactions: [{faction: 'millers', dir: 1}, {faction: 'merchants', dir: -1}]},
      {key: 'later', label: 'Not now', tradeoff: 'The Authority will ask again in three years.', reactions: []},
    ],
    debate: {
      for: [{faction: 'merchants', label: 'Merchants', note: 'likely to back it', p: 0.78}, {faction: 'farmers', label: 'Farmers', note: 'split', p: 0.51}],
      against: [{faction: 'millers', label: 'Millers', note: 'fear losing water rights', p: 0.62}],
    },
    details: [{label: 'Crossings a day', value: '412'}, {label: 'Floods in ten years', value: '3'}, {label: 'Time saved', value: 'about an hour a day'}, {label: 'Coin in the chest', value: '3,120'}],
    expiresInMonths: 21,
  },
  {
    id: 'c-granary', kind: 'proposal', from: 'agri-council', era: 1, title: 'A granary by the mill',
    why: 'Two of the last five harvests were thin. The farmers want a store for bad years.',
    asker: {name: 'Owen Barley', role: 'Agricultural Council'}, urgency: 1, costLine: 'Costs 900 coin. Upkeep 20 a year.',
    options: [
      {key: 'build', label: 'Do it', tradeoff: 'Food lasts three months longer in a bad year.', cost: 900, reactions: [{faction: 'farmers', dir: 2}, {faction: 'labour', dir: 1}, {faction: 'merchants', dir: -1}]},
      {key: 'small', label: 'Build a small one', tradeoff: 'Half the cost. Half the store.', cost: 450, reactions: [{faction: 'farmers', dir: 1}]},
      {key: 'refuse', label: 'Refuse', tradeoff: 'The council will lose some patience with you.', reactions: [{faction: 'farmers', dir: -2}]},
    ],
    details: [{label: 'Food stored', value: '7 months'}, {label: 'Thin harvests', value: '2 of 5'}],
    expiresInMonths: 14,
  },
  {
    id: 'c-guild-form', kind: 'petition', from: 'moot', era: 1, title: 'The craftsfolk want a guild',
    why: 'There are now nine workshops. The craftsfolk want their own body. It would set fair prices and train apprentices.',
    asker: {name: 'Ivo Penhallow', role: 'Master joiner'}, urgency: 0, costLine: 'It asks for a share of the yearly tax.',
    options: [
      {key: 'standard', label: 'Form it, standard share', tradeoff: 'Six in every hundred coin of tax goes to the guild.', reactions: [{faction: 'crafts', dir: 2}, {faction: 'merchants', dir: -1}]},
      {key: 'small', label: 'Form it, small share', tradeoff: 'Three in a hundred. The guild will be grateful but stretched.', reactions: [{faction: 'crafts', dir: 1}]},
      {key: 'later', label: 'Not now', tradeoff: 'They will ask again in three years.', reactions: [{faction: 'crafts', dir: -1}]},
      {key: 'refuse', label: 'Refuse', tradeoff: 'They will not ask again for fifteen years. Some will be angry.', reactions: [{faction: 'crafts', dir: -2}]},
    ],
    expiresInMonths: 24,
  },
  {
    id: 'c-wells', kind: 'report', from: 'health-board', era: 3, title: 'Three new wells',
    why: 'The Health Board dug three wells this year, in the Low Quarter and by the tannery. Fewer people fell sick.',
    asker: {name: 'Dr Elspeth Varro', role: 'Health Board'}, urgency: 0, costLine: 'Spent 540 of its 800 coin cap.',
    options: [{key: 'ack', label: 'Noted', tradeoff: '', reactions: []}],
    expiresInMonths: 12,
  },
  {
    id: 'c-strike', kind: 'event', from: 'union', era: 3, title: 'The mill hands walk out',
    why: 'Pay at the big mills fell again. The mill hands have stopped work. They are gathered at the mill gates.',
    asker: {name: 'Bram Kettle', role: "Workers' Union"}, urgency: 2, costLine: 'Mill output stops while the strike lasts.',
    options: [
      {key: 'workers', label: 'Side with the workers', tradeoff: 'Raise the wage floor. The mill owners will be sour.', reactions: [{faction: 'labour', dir: 2}, {faction: 'millers', dir: -2}, {faction: 'merchants', dir: -1}]},
      {key: 'owners', label: 'Side with the owners', tradeoff: 'Send the watch. Work starts again, but anger grows.', reactions: [{faction: 'millers', dir: 2}, {faction: 'labour', dir: -2}]},
      {key: 'mediate', label: 'Pay for a mediator', tradeoff: 'Costs 700 coin. Both sides give a little.', cost: 700, reactions: [{faction: 'labour', dir: 1}, {faction: 'millers', dir: 1}]},
    ],
    debate: {
      for: [{faction: 'labour', label: 'Labourers', note: 'will march if refused', p: 0.71}, {faction: 'newcomers', label: 'Newcomers', note: 'mostly with them', p: 0.58}],
      against: [{faction: 'millers', label: 'Millers', note: 'say the mills cannot pay', p: 0.66}, {faction: 'merchants', label: 'Merchants', note: 'want calm streets', p: 0.54}],
    },
    expiresInMonths: 3,
  },
  {
    id: 'c-lamps', kind: 'demand', from: 'watch', era: 3, title: 'Lamps on the river streets',
    why: 'Thefts by the quay doubled this year. The Watch wants lamps along the river streets. It has the backing to insist.',
    asker: {name: 'Captain Hale', role: 'Town Watch'}, urgency: 1, costLine: 'Costs 1,100 coin. Upkeep 40 a year.',
    options: [
      {key: 'yes', label: 'Do it', tradeoff: 'Safer nights. A steady cost.', cost: 1100, reactions: [{faction: 'merchants', dir: 1}, {faction: 'gentry', dir: 1}]},
      {key: 'negotiate', label: 'Half the streets for now', tradeoff: 'Costs 600. The Watch accepts, but its patience drops.', cost: 600, reactions: [{faction: 'merchants', dir: 1}]},
    ],
    expiresInMonths: 10,
  },
  {
    id: 'c-schooling', kind: 'debate', from: 'school-board', era: 3, title: 'School for every child',
    why: 'Four in ten people can read. The School Board wants the town to pay for every child to go to school.',
    asker: {name: 'Agnes Moor', role: 'School Board'}, urgency: 1, costLine: 'Costs 1,800 coin a year.',
    options: [
      {key: 'yes', label: 'Do it', tradeoff: 'More readers in ten years. The parish loses its school.', cost: 1800, reactions: [{faction: 'scholars', dir: 2}, {faction: 'newcomers', dir: 1}, {faction: 'clergy', dir: -2}]},
      {key: 'parish', label: 'Pay the parish to teach', tradeoff: 'Cheaper. Lessons stay in the chapel.', cost: 900, reactions: [{faction: 'clergy', dir: 2}, {faction: 'scholars', dir: -1}]},
      {key: 'later', label: 'Not now', tradeoff: 'The Board will ask again in three years.', reactions: [{faction: 'scholars', dir: -1}]},
    ],
    debate: {
      for: [{faction: 'scholars', label: 'Scholars', note: 'strongly for', p: 0.84}, {faction: 'newcomers', label: 'Newcomers', note: 'likely for', p: 0.6}],
      against: [{faction: 'clergy', label: 'Clergy', note: 'want to keep teaching', p: 0.69}],
    },
    expiresInMonths: 16,
  },
  {
    id: 'c-fair', kind: 'proposal', from: 'arts-society', era: 4, title: 'A summer fair on the green',
    why: 'Visitors spend well in towns with a fair. The Society wants a three-day fair this summer.',
    asker: {name: 'Rosalind Fenn', role: 'Festival & Arts Society'}, urgency: 0, costLine: 'Costs 500 coin. It may bring 800 visitors.',
    options: [
      {key: 'fund', label: 'Fund it', tradeoff: 'A grand fair. The town grows in name.', cost: 500, reactions: [{faction: 'merchants', dir: 2}, {faction: 'clergy', dir: -1}]},
      {key: 'allow', label: 'Allow it', tradeoff: 'No cost. A smaller fair.', reactions: [{faction: 'merchants', dir: 1}]},
      {key: 'refuse', label: 'Refuse', tradeoff: 'A quiet summer.', reactions: [{faction: 'merchants', dir: -1}, {faction: 'clergy', dir: 1}]},
    ],
    expiresInMonths: 8,
  },
];

// Extra cards the stub deals into later sessions.
export const LATER_CARDS = [
  {
    kind: 'proposal', from: 'moot', title: 'A festival for the harvest',
    why: 'The harvest came in well. People want to mark it. A small feast would lift spirits.',
    asker: {name: 'Mara Hollin', role: 'Village steward'}, urgency: 0, costLine: 'Costs 300 coin.',
    options: [
      {key: 'fund', label: 'Do it', tradeoff: 'A happy autumn. Some coin spent.', cost: 300, reactions: [{faction: 'farmers', dir: 2}, {faction: 'clergy', dir: 1}]},
      {key: 'later', label: 'Not now', tradeoff: 'People will shrug and get on.', reactions: [{faction: 'farmers', dir: -1}]},
    ],
    expiresInMonths: 12,
  },
  {
    kind: 'petition', from: 'moot', title: 'Paths through the barley',
    why: 'People cut across the barley to reach the mill. The farmers are cross. A proper track would fix it.',
    asker: {name: 'Owen Barley', role: 'Farmer'}, urgency: 1, costLine: 'Costs 240 coin.',
    options: [
      {key: 'track', label: 'Lay a track', tradeoff: 'Faster walks to the mill. The field loses a strip.', cost: 240, reactions: [{faction: 'millers', dir: 1}, {faction: 'farmers', dir: 1}]},
      {key: 'fence', label: 'Fence the field', tradeoff: 'The barley is safe. The walk gets longer.', cost: 120, reactions: [{faction: 'farmers', dir: 2}, {faction: 'labour', dir: -1}]},
      {key: 'later', label: 'Not now', tradeoff: 'The path will keep wearing in.', reactions: []},
    ],
    expiresInMonths: 12,
  },
];

export const CHRONICLE = [
  [0, 0, 'line', 'Twenty-eight people settle by the Willow river.'],
  [0, 3, 'line', 'The first barley goes in on the east bank.'],
  [1, 2, 'decision', 'You funded three cottages. Families moved in by summer.'],
  [3, 9, 'line', 'A path wears in from the cottages to the mill.'],
  [6, 0, 'moment', 'Hearthvale is a village now. Homes can have two storeys.'],
  [8, 4, 'moment', 'The Agricultural Council sits for the first time.'],
  [9, 7, 'decision', 'You built a granary by the mill.'],
  [12, 5, 'line', 'A wet spring. The river came over the low meadow.'],
  [14, 1, 'moment', 'The Trades Guild sits for the first time.'],
  [19, 10, 'line', 'The track to the mill is a road now.'],
  [25, 0, 'moment', 'Hearthvale is a town now. Houses can rise to three storeys.'],
  [26, 2, 'moment', 'The River Authority sits for the first time.'],
  [31, 6, 'decision', 'You licensed a ferry at the mill ford.'],
  [33, 7, 'line', 'Fire took four houses in Tanner\'s Row.'],
  [34, 1, 'decision', 'You rebuilt Tanner\'s Row in brick.'],
  [41, 4, 'line', 'Merchants from downriver open two warehouses.'],
  [47, 3, 'moment', 'The Health Board sits for the first time.'],
  [55, 0, 'moment', 'Hearthvale is a borough now. The streets can be paved.'],
  [58, 8, 'line', 'Mill hands walked out for six days.'],
  [63, 2, 'decision', 'You let the Health Board run its own affairs.'],
  [71, 5, 'line', 'The first printing press arrives.'],
  [90, 0, 'moment', 'Hearthvale is a city now. Buildings can rise to six storeys.'],
  [93, 6, 'decision', 'You set a wage floor. Pay rose in the mills.'],
  [96, 9, 'line', 'Lamps went up along the river streets.'],
];
