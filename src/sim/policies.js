// The Rule Book: what rules exist, what each one does, and how rules pull
// against each other and against the grain of the town (design-systems §4).
//
// Catalogue fields (per-level values are arrays indexed by level - 1):
//   category, title, summary     what the player reads in the Rule Book
//   pitch, tradeoff              used when a body proposes the rule
//   maxLevel, levelNames         levels 1..maxLevel (0 = not in force)
//   upkeep                       coin per year at each level (era-scaled)
//   deltas                       monthly pressure/trait deltas at each level
//   mul / add                    modifiers other modules read via policyModifiers()
//   weights                      actor option weights, 'kind.option' -> multiplier
//                                (a number scales with level; an array is per level)
//   requires                     condition (DSL) to adopt
//   tensions                     rule ids this one openly pulls against
//   helps / hurts                trades that gain or lose (faction stances, snapshots)
//   by                           bodies that draft this rule ('moot' drafts anything)
//   oneOff                       applied once (instant deltas), then stands with no upkeep
//   locks                        rule ids that may not stand alongside this one

import {holds, makeCtx} from './conditions.js';
import {delta, priceLevel} from './pressures.js';
import {fill} from './text/voice.js';

export const TRAITS = ['industry', 'market', 'innovation', 'authority'];

export const CATEGORIES = [
  {id: 'land', title: 'Land', blurb: 'Who may use the fields, and how.'},
  {id: 'labour', title: 'Work', blurb: 'Wages, hours and who may work.'},
  {id: 'trade', title: 'Trade', blurb: 'Markets, tolls and prices.'},
  {id: 'tax', title: 'Taxes', blurb: 'How the town pays its way.'},
  {id: 'food', title: 'Food', blurb: 'Stores, imports and lean years.'},
  {id: 'health', title: 'Health', blurb: 'Clean water and care for the sick.'},
  {id: 'education', title: 'Schooling', blurb: 'Who learns to read, and where.'},
  {id: 'faith', title: 'Faith and feasts', blurb: 'Holy days, the chapel and the fair.'},
  {id: 'environment', title: 'Land and river', blurb: 'Woods, banks and the river.'},
  {id: 'infrastructure', title: 'Streets and works', blurb: 'Paving, lamps and bridges.'},
  {id: 'civic', title: 'Rights and voice', blurb: 'Who speaks, and who keeps order.'},
];

// UI unlocks by era: which categories the Rule Book shows (design-systems §2, §9.2).
export const CATEGORY_ERA = {
  land: 0, food: 0, tax: 0, trade: 1, labour: 1, faith: 1, environment: 1,
  health: 2, education: 2, infrastructure: 2, civic: 2,
};

const has = (kind, id, level) => (level ? ['has', kind, id, level] : ['has', kind, id]);

export const POLICIES = {
  // ------------------------------------------------------------------ Land
  commons: {
    category: 'land', title: 'Common grazing', maxLevel: 2, levelNames: ['Shared', 'Wide commons'],
    summary: 'Every family may graze animals on the shared common.',
    pitch: 'Poor families need somewhere to keep a cow. The common feeds them all.',
    tradeoff: 'Landowners cannot fence the best fields.',
    upkeep: [10, 20], deltas: {market: [-0.004, -0.01], industry: [-0.002, -0.003]},
    weights: {'household_stay_move.stay': 1.1, 'enterprise_plan.expand': 0.9},
    tensions: ['enclosure'], helps: ['farm', 'labour'], hurts: ['gentry'], by: ['agri-council'],
  },
  enclosure: {
    category: 'land', title: 'Fenced fields', maxLevel: 3, levelNames: ['Some fences', 'Most fields', 'All fields'],
    summary: 'Landowners may fence the open fields for their own use.',
    pitch: 'Fenced fields grow more grain. The big farms are ready to invest.',
    tradeoff: 'Poor families lose the common. Some will leave.',
    upkeep: [0, 0, 0],
    deltas: {market: [0.004, 0.008, 0.012], ecology: [-0.001, -0.002, -0.003]},
    mul: {farmYield: [1.1, 1.2, 1.3]}, add: {inequalityShift: [0.01, 0.02, 0.03]},
    weights: {'household_stay_move.emigrate': 1.15, 'enterprise_plan.expand': 1.1},
    tensions: ['commons'], helps: ['gentry'], hurts: ['labour', 'farm'], by: ['agri-council', 'exchange'],
  },
  zoning: {
    category: 'land', title: 'Building zones', maxLevel: 3, levelNames: ['Light', 'Firm', 'Strict'],
    summary: 'The Planning Office says where homes may rise, and how tall.',
    pitch: 'Homes are going up wherever there is a gap. A plan would keep streets clear.',
    tradeoff: 'Builders lose some freedom. Rents may rise a little.',
    requires: has('institution', 'planning'),
    upkeep: [30, 50, 80], deltas: {authority: [0.003, 0.005, 0.008]},
    add: {zoningDensity: [0.6, 0.75, 0.9]},
    weights: {'household_home.rebuild_up': 1.1, 'choose_site.wait': 1.2},
    helps: ['clerical'], hurts: ['gentry'], by: ['planning'],
  },
  'park-reserve': {
    category: 'land', title: 'Green reserves', maxLevel: 3, levelNames: ['A meadow', 'Parks', 'Green belt'],
    summary: 'Some land stays open as parks and meadows.',
    pitch: 'The town is filling up. Open ground now will be priceless later.',
    tradeoff: 'Fewer lots to build on. Land costs more.',
    upkeep: [20, 40, 60],
    deltas: {ecology: [0.004, 0.007, 0.01], prestige: [0.001, 0.0015, 0.002]},
    add: {parkReserve: [1, 2, 3]}, weights: {'household_stay_move.stay': 1.05},
    helps: ['clerical', 'gentry'], hurts: ['labour'], by: ['planning', 'arts-society'],
  },

  // ------------------------------------------------------------------ Work
  apprenticeship: {
    category: 'labour', title: 'Apprenticeships', maxLevel: 2, levelNames: ['Encouraged', 'Required'],
    summary: 'Young people learn a craft from a master.',
    pitch: 'Our masters are getting old. Their skills should not die with them.',
    tradeoff: 'Old ways stay strong. New methods come more slowly.',
    upkeep: [10, 20], deltas: {innovation: [-0.002, -0.003]},
    mul: {goodsQuality: [1.05, 1.1]}, weights: {'choose_trade.craft': 1.3},
    helps: ['craft'], hurts: ['labour'], by: ['trades-guild'],
  },
  'wage-floor': {
    category: 'labour', title: 'A wage floor', maxLevel: 3, levelNames: ['Low floor', 'Fair floor', 'High floor'],
    summary: 'No one may be paid below a fixed wage.',
    pitch: 'Some workers earn too little to eat. A floor would keep families fed.',
    tradeoff: 'Owners hire fewer hands. Some may buy machines instead.',
    upkeep: [0, 0, 0], deltas: {market: [-0.002, -0.004, -0.006]},
    mul: {wages: [1.08, 1.16, 1.25]}, add: {inequalityShift: [-0.01, -0.02, -0.03]},
    weights: {'enterprise_plan.expand': 0.8, 'enterprise_plan.automate': 1.2, 'react_to_policy.strike': 0.7},
    tensions: ['free-trade'], helps: ['labour'], hurts: ['gentry', 'trade'], by: ['union'],
  },
  'hours-cap': {
    category: 'labour', title: 'Shorter hours', maxLevel: 2, levelNames: ['Ten hours', 'Eight hours'],
    summary: 'No worker may be kept longer than a set day.',
    pitch: 'Workers fall ill from long days. Rested hands make fewer mistakes.',
    tradeoff: 'Workshops and mills make less.',
    upkeep: [0, 0], deltas: {health: [0.003, 0.005]},
    mul: {output: [0.95, 0.88]}, weights: {'react_to_policy.strike': 0.8},
    helps: ['labour'], hurts: ['gentry', 'craft'], by: ['union', 'health-board'],
  },
  'child-labour-ban': {
    category: 'labour', title: 'No child labour', maxLevel: 1, levelNames: ['In force'],
    summary: 'Children go to school, not to the mill.',
    pitch: 'Children are working the looms. They should be learning their letters.',
    tradeoff: 'Farms and mills lose cheap hands. Some families lose a wage.',
    requires: has('institution', 'school-board'),
    upkeep: [10], deltas: {learning: [0.003], industry: [-0.001]},
    mul: {farmYield: [0.96], millOutput: [0.96]},
    helps: ['clerical'], hurts: ['farm', 'gentry'], by: ['school-board'],
  },

  // ------------------------------------------------------------------ Trade
  'market-charter': {
    category: 'trade', title: 'A market charter', maxLevel: 2, levelNames: ['Weekly', 'Twice weekly'],
    summary: 'The town holds a market with fair weights and set days.',
    pitch: 'Traders come from the valley. A charter would bring them every week.',
    tradeoff: 'The square gets busy. Old shops face new rivals.',
    requires: ['gte', 'C.markets', 1],
    upkeep: [20, 30], deltas: {market: [0.004, 0.006]},
    mul: {tradeVolume: [1.15, 1.25]},
    tensions: ['sabbath-rule'], helps: ['trade', 'farm'], hurts: ['craft'], by: ['exchange', 'moot'],
  },
  tolls: {
    category: 'trade', title: 'Road and river tolls', maxLevel: 3, levelNames: ['Light', 'Fair', 'Heavy'],
    summary: 'Carts and boats pay a fee to use our roads and river.',
    pitch: 'Strangers wear out our roads for free. A toll would pay for repairs.',
    tradeoff: 'Tolls bring coin. But boats will come less often.',
    upkeep: [0, 0, 0], deltas: {riverTrade: [-0.003, -0.005, -0.008]},
    add: {tollIncome: [60, 140, 240]},
    tensions: ['free-trade'], helps: ['craft'], hurts: ['trade'], by: ['river-authority', 'moot'],
  },
  'free-trade': {
    category: 'trade', title: 'Free trade', maxLevel: 2, levelNames: ['Open', 'Wide open'],
    summary: 'Goods come and go without fees or limits.',
    pitch: 'Other towns trade freely and grow rich. We could too.',
    tradeoff: 'Cheap goods arrive. Local makers will struggle.',
    upkeep: [0, 0],
    deltas: {market: [0.006, 0.01], riverTrade: [0.004, 0.007]},
    mul: {goodsPrice: [0.95, 0.9], tradeVolume: [1.1, 1.2]},
    weights: {'enterprise_plan.close': 1.15},
    tensions: ['tolls', 'wage-floor', 'price-floor'], helps: ['trade', 'gentry'], hurts: ['craft'],
    by: ['exchange'],
  },
  'price-floor': {
    category: 'trade', title: 'Guild prices', maxLevel: 2, levelNames: ['Some goods', 'All guild goods'],
    summary: 'Guild goods may not be sold below a set price.',
    pitch: 'Pedlars sell shoddy goods cheap. Our makers cannot match them.',
    tradeoff: 'Makers are safe. Buyers pay more.',
    requires: has('institution', 'trades-guild'),
    upkeep: [0, 0], deltas: {market: [-0.003, -0.005]},
    mul: {goodsPrice: [1.05, 1.1]}, weights: {'enterprise_plan.close': 0.7},
    tensions: ['free-trade'], helps: ['craft'], hurts: ['labour', 'trade'], by: ['trades-guild'],
  },

  // ------------------------------------------------------------------ Taxes
  'property-tax': {
    category: 'tax', title: 'Property tax', maxLevel: 4, levelNames: ['8 in 100', '12 in 100', '16 in 100', '20 in 100'],
    summary: 'Every home pays a share of its worth each year.',
    pitch: 'The town needs coin for its works. Homes can pay a fair share.',
    tradeoff: 'More coin for the town. Less in every purse.',
    upkeep: [0, 0, 0, 0], deltas: {unrest: [0, 0, 0.002, 0.005]},
    add: {propertyTax: [8, 12, 16, 20]},
    weights: {'household_stay_move.emigrate': [0.85, 1, 1.15, 1.3], 'household_home.rebuild_up': [1.1, 1, 0.9, 0.8]},
    helps: [], hurts: ['gentry'], by: ['moot'],
  },
  'income-tax': {
    category: 'tax', title: 'Income tax', maxLevel: 4, levelNames: ['5 in 100', '10 in 100', '18 in 100', '25 in 100'],
    summary: 'People pay a share of their wages.',
    pitch: 'Wages have grown. Those who earn more can give more.',
    tradeoff: 'The town grows richer. People keep less of their pay.',
    requires: ['era', 2],
    upkeep: [0, 0, 0, 0],
    deltas: {unrest: [0, 0.001, 0.003, 0.006], market: [0, -0.001, -0.002, -0.003]},
    add: {incomeTax: [5, 10, 18, 25]},
    weights: {'household_stay_move.emigrate': [1, 1.05, 1.15, 1.25]},
    helps: ['labour'], hurts: ['trade', 'gentry'], by: ['moot'],
  },
  tithe: {
    category: 'tax', title: 'The tithe', maxLevel: 3, levelNames: ['Small', 'Tenth', 'Heavy'],
    summary: 'Households give a share to the chapel.',
    pitch: 'The chapel feeds the poor and keeps the feasts. It needs a steady gift.',
    tradeoff: 'Faith grows strong. Purses grow thin.',
    requires: has('institution', 'parish'),
    upkeep: [0, 0, 0], deltas: {faith: [0.004, 0.008, 0.012]},
    add: {titheShare: [2, 4, 6]},
    tensions: ['free-schooling'], helps: ['clergy'], hurts: ['labour', 'trade'], by: ['parish'],
  },
  'land-value-tax': {
    category: 'tax', title: 'Land value tax', maxLevel: 2, levelNames: ['Partial', 'Full'],
    summary: 'Land pays by its worth, not by what stands on it.',
    pitch: 'Empty lots sit idle while people wait for homes. This would put them to use.',
    tradeoff: 'Idle land must be built on or sold. Landowners will object.',
    requires: ['and', has('institution', 'planning'), ['era', 2]],
    upkeep: [10, 20], deltas: {authority: [0.001, 0.002], market: [0.001, 0.002]},
    add: {inequalityShift: [-0.01, -0.02], densityPush: [0.05, 0.1], landTax: [1, 2]},
    // Dear land is put to use: sites change hands and homes are rebuilt bigger.
    weights: {'enterprise_plan.sell_site': 1.3, 'enterprise_plan.relocate': 1.2, 'farm_land.sell_some_plots': 1.3,
      'farm_land.sell_all_and_move_out': 1.2, 'household_home.rebuild_up': 1.2},
    tensions: ['enclosure', 'rent-cap', 'workshop-quarter'], helps: ['labour'], hurts: ['gentry', 'farm'], by: ['planning', 'exchange'],
  },
  'rent-cap': {
    category: 'land', title: 'A rent cap', maxLevel: 2, levelNames: ['Gentle cap', 'Firm cap'],
    summary: 'Ground rents may rise only so fast.',
    pitch: 'Old shops and small farms are priced out of the centre. A cap would let them stay.',
    tradeoff: 'Small businesses stay put. Fewer new buildings go up.',
    requires: ['era', 1],
    upkeep: [10, 20], deltas: {market: [-0.002, -0.004]},
    add: {rentCap: [0.9, 0.8]},
    weights: {'enterprise_plan.relocate': [0.7, 0.5], 'enterprise_plan.sell_site': [0.7, 0.5], 'farm_land.sell_some_plots': [0.8, 0.6],
      'farm_land.sell_all_and_move_out': [0.7, 0.5], 'household_home.rebuild_up': [0.9, 0.8], 'household_stay_move.emigrate': [0.9, 0.85]},
    tensions: ['land-value-tax'], helps: ['craft', 'farm', 'labour'], hurts: ['gentry', 'trade'], by: ['trades-guild', 'agri-council', 'moot'],
  },
  'workshop-quarter': {
    category: 'land', title: 'A workshop quarter', maxLevel: 1, levelNames: ['Kept'],
    summary: 'One quarter is kept for makers. No one may push them out.',
    pitch: 'Workshops are being bought up for houses. Keep one quarter for the trades.',
    tradeoff: 'The crafts keep a home. That land cannot be built up.',
    requires: ['or', has('institution', 'trades-guild'), has('institution', 'planning')],
    upkeep: [10], deltas: {industry: [0.001], market: [-0.001]},
    add: {workshopQuarter: [1]},
    weights: {'enterprise_plan.relocate': 0.6, 'enterprise_plan.sell_site': 0.6},
    tensions: ['land-value-tax'], helps: ['craft'], hurts: ['gentry', 'trade'], by: ['trades-guild', 'planning'],
  },

  // ------------------------------------------------------------------ Food
  granary: {
    category: 'food', title: 'The town granary', maxLevel: 3, levelNames: ['A barn', 'A granary', 'Great stores'],
    summary: 'The town stores grain against lean years.',
    pitch: 'One bad harvest could starve us. A granary would carry us through.',
    tradeoff: 'It costs coin every year, even in good years.',
    upkeep: [40, 80, 120], deltas: {health: [0.001, 0.0015, 0.002]},
    add: {foodBufferMonths: [3, 6, 9]}, mul: {famineChance: [0.5, 0.4, 0.3]},
    helps: ['farm', 'labour'], hurts: [], by: ['agri-council', 'moot'],
  },
  'grain-import': {
    category: 'food', title: 'Grain from abroad', maxLevel: 2, levelNames: ['When short', 'Every season'],
    summary: 'The town buys grain from the boats when stores run low.',
    pitch: 'Our fields cannot feed everyone. The boats bring grain from the south.',
    tradeoff: 'Bread is cheaper. Our farmers get less for theirs.',
    upkeep: [120, 240], deltas: {riverTrade: [0.002, 0.004]},
    add: {grainImport: [1, 2]},
    helps: ['labour', 'trade'], hurts: ['farm'], by: ['exchange', 'moot'],
  },
  'fast-days': {
    category: 'food', title: 'Fast days', maxLevel: 2, levelNames: ['Some days', 'Many days'],
    summary: 'On set days people eat less and pray.',
    pitch: 'Stores are low. Fasting would stretch them and bring us closer to God.',
    tradeoff: 'Food lasts longer. Hungry people grumble.',
    upkeep: [0, 0], deltas: {faith: [0.002, 0.004], unrest: [0.001, 0.002]},
    mul: {foodUse: [0.94, 0.9]},
    helps: ['clergy'], hurts: ['labour'], by: ['parish'],
  },
  'market-gardens': {
    category: 'food', title: 'Market gardens', maxLevel: 2, levelNames: ['Some plots', 'Many plots'],
    summary: 'Small plots near town grow fresh greens.',
    pitch: 'Fresh greens keep people well. The edge of town has good soil.',
    tradeoff: 'Gardens take land that homes could use.',
    requires: ['or', has('policy', 'park-reserve'), ['gte', 'P.ecology', 0.7]],
    upkeep: [10, 20], deltas: {ecology: [0.002, 0.003], health: [0.001, 0.002], industry: [-0.001, -0.002]},
    mul: {food: [1.05, 1.08]},
    helps: ['farm'], hurts: [], by: ['agri-council'],
  },

  // ------------------------------------------------------------------ Health
  wells: {
    category: 'health', title: 'Public wells', maxLevel: 3, levelNames: ['A few', 'One per quarter', 'Many'],
    summary: 'Clean wells give every street fresh water.',
    pitch: 'People drink from the river. That is how sickness spreads.',
    tradeoff: 'Digging costs coin. Wells need care.',
    upkeep: [30, 60, 90], deltas: {health: [0.003, 0.005, 0.008]},
    helps: ['labour'], hurts: [], by: ['health-board', 'moot'],
  },
  sewers: {
    category: 'health', title: 'Sewers', maxLevel: 3, levelNames: ['Main street', 'Most streets', 'Every street'],
    summary: 'Covered drains carry waste away from homes.',
    pitch: 'The gutters stink in summer. Sewers would end the fevers.',
    tradeoff: 'Sewers are dear to build and keep.',
    requires: ['era', 2],
    upkeep: [120, 240, 400], deltas: {health: [0.006, 0.012, 0.02], ecology: [0.001, 0.002, 0.003]},
    helps: ['labour', 'clerical'], hurts: ['gentry'], by: ['health-board'],
  },
  infirmary: {
    category: 'health', title: 'The infirmary', maxLevel: 2, levelNames: ['A sick house', 'A hospital'],
    summary: 'A house for the sick, with beds and a healer.',
    pitch: 'The sick lie at home with no one to tend them.',
    tradeoff: 'Beds and healers cost coin each year.',
    upkeep: [60, 120], deltas: {health: [0.002, 0.003]},
    mul: {plagueDeaths: [0.5, 0.4]},
    helps: ['labour'], hurts: [], by: ['health-board', 'parish'],
  },
  'smoke-limits': {
    category: 'health', title: 'Smoke limits', maxLevel: 2, levelNames: ['Some limits', 'Strict limits'],
    summary: 'Mills and kilns must keep their smoke down.',
    pitch: 'Soot blackens the washing and the lungs. The chimneys must be tamed.',
    tradeoff: 'The air clears. The mills make less.',
    upkeep: [10, 20], deltas: {ecology: [0.004, 0.007], industry: [-0.002, -0.004], health: [0.001, 0.002]},
    mul: {millOutput: [0.95, 0.9]},
    tensions: ['mill-rights'], helps: ['clerical', 'farm'], hurts: ['craft', 'gentry'], by: ['health-board'],
  },
  quarantine: {
    category: 'health', title: 'Quarantine', maxLevel: 1, levelNames: ['In force'],
    summary: 'In a plague, sick houses are closed until it passes.',
    pitch: 'If plague comes, we must stop it at the door.',
    tradeoff: 'Fewer die. Shut-in families grow angry.',
    requires: has('institution', 'health-board'),
    upkeep: [10], deltas: {},
    whileTag: {tag: 'plague', within: 1, deltas: {unrest: 0.01}},
    mul: {plagueDeaths: [0.6]},
    helps: [], hurts: ['trade'], by: ['health-board'],
  },

  // ------------------------------------------------------------------ Schooling
  'parish-school': {
    category: 'education', title: 'A parish school', maxLevel: 1, levelNames: ['Open'],
    summary: 'The chapel teaches children to read.',
    pitch: 'Children should read the scriptures. The chapel can teach them.',
    tradeoff: 'Children learn. The chapel shapes what they learn.',
    requires: has('institution', 'parish'),
    upkeep: [30], deltas: {learning: [0.002], faith: [0.001]},
    helps: ['clergy'], hurts: [], by: ['parish'],
  },
  'free-schooling': {
    category: 'education', title: 'Free schooling', maxLevel: 2, levelNames: ['Young children', 'All children'],
    summary: 'Every child may go to school for free.',
    pitch: 'Only the rich can pay the schoolmaster. Clever poor children go to waste.',
    tradeoff: 'It costs a great deal. Fewer children earn at home.',
    requires: has('institution', 'school-board'),
    upkeep: [150, 260], deltas: {learning: [0.006, 0.009], innovation: [0.001, 0.002]},
    weights: {'choose_trade.clerical': 1.3},
    tensions: ['tithe'], helps: ['labour', 'clerical'], hurts: ['gentry'], by: ['school-board'],
  },
  library: {
    category: 'education', title: 'A lending library', maxLevel: 1, levelNames: ['Open'],
    summary: 'Anyone may borrow books for free.',
    pitch: 'Books are dear. A library would let everyone read.',
    tradeoff: 'A small cost each year.',
    upkeep: [50], deltas: {learning: [0.002], prestige: [0.001]},
    helps: ['clerical'], hurts: [], by: ['school-board', 'arts-society'],
  },
  'press-licence': {
    category: 'education', title: 'A printing licence', maxLevel: 1, levelNames: ['Granted'],
    summary: 'Printers may publish news and pamphlets.',
    pitch: 'A printer wants to set up shop. News would travel faster.',
    tradeoff: 'Ideas spread. So does grumbling.',
    requires: ['era', 2],
    upkeep: [0], deltas: {innovation: [0.004], unrest: [0.001]},
    mul: {petitionRate: [1.2]},
    helps: ['clerical'], hurts: ['clergy'], by: ['school-board'],
  },

  // ------------------------------------------------------------------ Faith and feasts
  'feast-days': {
    category: 'faith', title: 'Feast days', maxLevel: 2, levelNames: ['The great feasts', 'Every saint'],
    summary: 'The town keeps the holy days with food and music.',
    pitch: 'Feast days bring us together. People need joy as well as bread.',
    tradeoff: 'Spirits lift. Work stops for the day.',
    upkeep: [20, 40], deltas: {faith: [0.003, 0.005], unrest: [-0.002, -0.003]},
    mul: {output: [0.98, 0.96]}, add: {happiness: [2, 4]},
    helps: ['clergy', 'labour'], hurts: ['gentry'], by: ['parish', 'moot'],
  },
  'sabbath-rule': {
    category: 'faith', title: 'A day of rest', maxLevel: 1, levelNames: ['Kept'],
    summary: 'No one trades on the day of rest.',
    pitch: 'The market runs every day now. People have no time to rest or pray.',
    tradeoff: 'People rest. Trade slows.',
    upkeep: [0], deltas: {faith: [0.004], health: [0.001]},
    mul: {tradeVolume: [0.94]},
    tensions: ['market-charter'], helps: ['clergy', 'labour'], hurts: ['trade'], by: ['parish'],
  },
  'festival-fund': {
    category: 'faith', title: 'A festival fund', maxLevel: 2, levelNames: ['A summer fair', 'A festival season'],
    summary: 'The town pays for music, games and a summer fair.',
    pitch: 'Visitors spend freely at a good fair. Our name would travel.',
    tradeoff: 'It costs coin. Some call it waste.',
    upkeep: [60, 120], deltas: {prestige: [0.003, 0.005], unrest: [-0.002, -0.003]},
    add: {happiness: [3, 5]},
    helps: ['trade', 'labour'], hurts: ['clergy'], by: ['arts-society'],
  },
  monument: {
    category: 'faith', title: 'A town monument', maxLevel: 1, levelNames: ['Raised'], oneOff: true,
    summary: 'A tall column marks our story in the square.',
    pitch: 'Great towns have great monuments. Ours would draw visitors for years.',
    tradeoff: 'It costs a lot once. Then it simply stands.',
    cost: 800, upkeep: [0], deltas: {}, instant: {prestige: 0.1},
    building: 'monument', helps: ['gentry'], hurts: ['labour'], by: ['arts-society', 'moot'],
  },

  // ------------------------------------------------------------------ Land and river
  'riverbank-protect': {
    category: 'environment', title: 'Riverbank care', maxLevel: 2, levelNames: ['Planted banks', 'Stone banks'],
    summary: 'Banks are planted and walled against floods.',
    pitch: 'Each spring the river takes more of the bank. We must hold it.',
    tradeoff: 'Floods do less harm. The work costs coin each year.',
    upkeep: [40, 80], deltas: {ecology: [0.002, 0.003]},
    mul: {floodDamage: [0.5, 0.35]},
    helps: ['farm'], hurts: [], by: ['river-authority'],
  },
  'woodland-reserve': {
    category: 'environment', title: 'Woodland reserve', maxLevel: 2, levelNames: ['Old woods', 'All woods'],
    summary: 'The old woods may not be cut.',
    pitch: 'The woods are thinning. Once gone, they take a lifetime to return.',
    tradeoff: 'Timber costs more. The woods stay green.',
    upkeep: [10, 20], deltas: {ecology: [0.003, 0.005], industry: [-0.001, -0.002]},
    helps: ['farm', 'clerical'], hurts: ['craft'], by: ['agri-council'],
  },
  'mill-rights': {
    category: 'environment', title: 'Water-mill rights', maxLevel: 2, levelNames: ['Some mills', 'Any mill'],
    summary: 'Mills may take water from the river.',
    pitch: 'The river could turn a dozen wheels. Mills mean work.',
    tradeoff: 'Mills mean work. The river and the fish will suffer.',
    upkeep: [0, 0], deltas: {industry: [0.003, 0.005], ecology: [-0.003, -0.005]},
    mul: {millOutput: [1.1, 1.2]}, weights: {'enterprise_found.mill': 1.5},
    tensions: ['smoke-limits'], helps: ['craft', 'gentry'], hurts: ['farm'], by: ['river-authority', 'trades-guild'],
  },
  'clean-water-rule': {
    category: 'environment', title: 'Clean water rule', maxLevel: 1, levelNames: ['In force'],
    summary: 'No one may tip waste into the river.',
    pitch: 'The river runs brown below the dye works. People drink that water.',
    tradeoff: 'The river clears. Mills and dyers pay more.',
    requires: ['era', 1],
    upkeep: [10], deltas: {health: [0.004], ecology: [0.002]},
    mul: {millOutput: [0.97]},
    helps: ['farm', 'labour'], hurts: ['craft'], by: ['health-board', 'river-authority'],
  },

  // ------------------------------------------------------------------ Streets and works
  'paving-fund': {
    category: 'infrastructure', title: 'A paving fund', maxLevel: 3, levelNames: ['Small', 'Steady', 'Generous'],
    summary: 'Each year the busiest lanes are paved.',
    pitch: 'The main lanes turn to mud each spring. A fund would pave them bit by bit.',
    tradeoff: 'Streets improve each year. So does the bill.',
    requires: ['era', 2],
    upkeep: [150, 300, 500], deltas: {authority: [0.001, 0.002, 0.003]},
    add: {pavingBudget: [150, 300, 500]},
    helps: ['trade'], hurts: [], by: ['planning'],
  },
  lamps: {
    category: 'infrastructure', title: 'Street lamps', maxLevel: 2, levelNames: ['Main streets', 'Every street'],
    summary: 'Lamps light the streets at night.',
    pitch: 'The streets are dark after sunset. Lamps would make people feel safe.',
    tradeoff: 'Oil and lamplighters cost coin.',
    requires: ['era', 2],
    upkeep: [50, 100], deltas: {unrest: [-0.005, -0.008]},
    add: {lamps: [1, 2]},
    helps: ['trade', 'clerical'], hurts: [], by: ['watch', 'planning'],
  },
  'bridge-fund': {
    category: 'infrastructure', title: 'A bridge fund', maxLevel: 1, levelNames: ['Set aside'],
    summary: 'Coin is set aside each year for new bridges.',
    pitch: 'The ford is crowded and dangerous. We should save for a bridge.',
    tradeoff: 'The coin cannot be spent on anything else.',
    upkeep: [200], deltas: {riverTrade: [0.002]},
    add: {bridgeBudget: [200]},
    helps: ['trade'], hurts: [], by: ['river-authority'],
  },
  drainage: {
    category: 'infrastructure', title: 'Field drainage', maxLevel: 2, levelNames: ['Low fields', 'All fields'],
    summary: 'Ditches drain the wet fields.',
    pitch: 'The low fields flood every spring. Ditches would save the crop.',
    tradeoff: 'More grain. The marsh birds will go.',
    upkeep: [40, 70], deltas: {ecology: [-0.001, -0.001], industry: [-0.001, -0.001]},
    mul: {floodChance: [0.6, 0.5], farmYield: [1.08, 1.12]},
    helps: ['farm'], hurts: [], by: ['agri-council', 'river-authority'],
  },

  // ------------------------------------------------------------------ Rights and voice
  'open-moot': {
    category: 'civic', title: 'An open moot', maxLevel: 1, levelNames: ['Open'],
    summary: 'Anyone may speak at the moot and bring a petition.',
    pitch: 'People feel unheard. An open moot would let them speak.',
    tradeoff: 'More voices. More petitions to read.',
    upkeep: [10], deltas: {authority: [-0.004], unrest: [-0.005]},
    mul: {petitionRate: [2]},
    tensions: ['curfew'], helps: ['labour', 'farm'], hurts: ['gentry'], by: ['moot'],
  },
  'guild-vote': {
    category: 'civic', title: 'Guild seats', maxLevel: 1, levelNames: ['Seated'],
    summary: 'The guilds get seats at the council.',
    pitch: 'The guilds make the town rich. They should have a say.',
    tradeoff: 'The guilds gain power. Others lose a little.',
    requires: has('institution', 'trades-guild'),
    upkeep: [0], deltas: {market: [-0.001], authority: [0.001]},
    add: {guildPower: [0.2]},
    helps: ['craft'], hurts: ['labour'], by: ['trades-guild'],
  },
  curfew: {
    category: 'civic', title: 'A curfew', maxLevel: 1, levelNames: ['In force'],
    summary: 'No one walks the streets after dark.',
    pitch: 'There is trouble at night. A curfew would end it quickly.',
    tradeoff: 'The nights go quiet. People resent it.',
    requires: has('institution', 'watch'),
    upkeep: [30], deltas: {authority: [0.004]}, instant: {unrest: -0.02},
    add: {happiness: [-3]},
    tensions: ['open-moot'], helps: ['gentry'], hurts: ['labour'], by: ['watch'],
  },
  'charter-of-rights': {
    category: 'civic', title: 'A charter of rights', maxLevel: 1, levelNames: ['Sealed'], oneOff: true,
    summary: 'Every resident has rights the council cannot take away.',
    pitch: 'People want their rights in writing. A charter would settle old quarrels.',
    tradeoff: 'Unrest falls. The council can never order a curfew again.',
    requires: ['era', 3],
    upkeep: [0], deltas: {}, instant: {unrest: -0.1, authority: -0.1},
    locks: ['curfew'], helps: ['labour', 'clerical'], hurts: ['gentry'], by: ['moot'],
  },
};

for (const [id, p] of Object.entries(POLICIES)) p.id = id;

export const POLICY_IDS = Object.keys(POLICIES);

// ---------------------------------------------------------------------------
// Reading the book
// ---------------------------------------------------------------------------

export const levelOf = (state, id) => state.policies?.[id]?.level ?? 0;

export function activePolicies(state) {
  return Object.entries(state.policies ?? {})
    .filter(([id, p]) => p.level > 0 && POLICIES[id])
    .map(([id, p]) => ({...p, id, def: POLICIES[id]}));
}

// Per-level value: arrays are indexed by level; numbers stand for level 1.
function atLevel(value, level) {
  if (Array.isArray(value)) return value[Math.min(level, value.length) - 1] ?? 0;
  return value;
}

// The catalogue's numbers are written for the spec's scale. Traits carry
// momentum and lock-in and have no pull back to zero, so a rule's monthly push
// is scaled down: one rule moves the town over decades, not years.
export const DELTA_SCALE = {trait: 0.05, pressure: 0.8};
// One-off pushes (a card, an event) on traits; momentum multiplies them ~5x.
export const ONE_OFF_TRAIT_SCALE = 0.3;
// Grumbling per month while a rule goes against the grain.
export const GRAIN_UNREST = 0.002;

const scaleFor = (key) => (TRAITS.includes(key) ? DELTA_SCALE.trait : DELTA_SCALE.pressure);

// A steady push on a pressure (0..1) fades as it nears the end of its range,
// so stacked rules approach a ceiling instead of pinning it.
export function steadyPush(state, key, amount) {
  if (TRAITS.includes(key)) return amount;
  const p = state.pressures?.[key] ?? 0.5;
  return amount * (amount > 0 ? 1 - p : p);
}

const popOf = (state) => state.indicators?.pop || (state.households ?? []).reduce((n, h) => n + (h.size ?? 1), 0);

// Coin scales follow the treasury's own yearly income (last year's, so a card
// costs the same all year). A bundle of ten everyday rules costs about a third
// of that income; a one-off like a fair costs about a twelfth.
export function fiscalBase(state) {
  const income = state.economy?.lastYear?.treasuryIncome ?? 0;
  const floor = 100 * priceLevel(state) * Math.max(0.3, popOf(state) / 30);
  return Math.max(income, Math.min(floor, 400 * priceLevel(state)));
}
export const upkeepScale = (state) => fiscalBase(state) / 2500;
export const costScale = (state) => Math.max(0.1, Math.min(40, fiscalBase(state) / 3000));

export function againstGrain(state, id, level = Math.max(1, levelOf(state, id))) {
  const def = POLICIES[id];
  if (!def) return {against: false, traits: [], factor: 1};
  const traits = [];
  let worst = 0;
  for (const k of TRAITS) {
    const d = atLevel(def.deltas?.[k] ?? 0, level) + (def.instant?.[k] ?? 0);
    const t = state.traits?.[k] ?? 0;
    if (d !== 0 && Math.abs(t) > 0.4 && Math.sign(d) !== Math.sign(t)) {
      traits.push(k);
      worst = Math.max(worst, Math.abs(t));
    }
  }
  return {against: traits.length > 0, traits, factor: 1 + 2 * worst};
}

export function upkeepFor(state, id, level = levelOf(state, id)) {
  const def = POLICIES[id];
  if (!def || level <= 0) return 0;
  const base = atLevel(def.upkeep ?? 0, level) * upkeepScale(state);
  return Math.round(base * againstGrain(state, id, level).factor);
}

export const yearlyUpkeep = (state) =>
  activePolicies(state).reduce((sum, p) => sum + upkeepFor(state, p.id, p.level), 0);

export function canAdopt(state, id, level = 1) {
  const def = POLICIES[id];
  if (!def || level < 0 || level > def.maxLevel) return false;
  if (def.requires && !holds(def.requires, makeCtx(state))) return false;
  for (const other of activePolicies(state)) {
    if (other.def.locks?.includes(id)) return false;
  }
  return true;
}

// Set a rule's level. 0 repeals it. Returns the change kind or null.
export function adoptPolicy(state, id, level, by = 'player') {
  const def = POLICIES[id];
  if (!def) return null;
  state.policies ??= {};
  const year = state.time?.year ?? 0;
  const before = levelOf(state, id);
  const next = Math.max(0, Math.min(def.maxLevel, Math.round(level)));
  if (next === before) return null;
  if (state.governance) {
    state.governance.rulesRev = (state.governance.rulesRev ?? 0) + 1;
    // Whoever changed it, no one asks to change it again for a while (subjects.js).
    (state.governance.ruleChanged ??= {})[id] = year;
  }
  if (next > 0) {
    state.policies[id] = {level: next, since: before > 0 ? state.policies[id].since : year, by};
  } else {
    delete state.policies[id];
  }
  if (before === 0 && next > 0 && def.instant) {
    for (const [key, amount] of Object.entries(def.instant)) {
      delta(state, key, amount * (TRAITS.includes(key) ? ONE_OFF_TRAIT_SCALE : 1), `rule:${id}`);
    }
  }
  for (const lockedId of def.locks ?? []) {
    if (next > 0 && levelOf(state, lockedId) > 0) delete state.policies[lockedId];
  }
  if (before === 0) return 'adopted';
  if (next === 0) return 'repealed';
  return next > before ? 'raised' : 'lowered';
}

// ---------------------------------------------------------------------------
// Monthly and yearly effects
// ---------------------------------------------------------------------------

// funding (0..1): the share of upkeep the town could pay this month.
export function policiesMonthly(state, funding = 1) {
  const year = state.time?.year ?? 0;
  for (const p of activePolicies(state)) {
    const def = p.def;
    if (def.oneOff) continue;
    const source = `rule:${p.id}`;
    for (const [key, values] of Object.entries(def.deltas ?? {})) {
      const amount = atLevel(values, p.level);
      if (amount) delta(state, key, steadyPush(state, key, amount * scaleFor(key) * funding), source);
    }
    if (def.whileTag) {
      const last = state.tags?.[def.whileTag.tag];
      if (last !== undefined && year - last <= def.whileTag.within) {
        for (const [key, amount] of Object.entries(def.whileTag.deltas)) delta(state, key, amount, source);
      }
    }
    if (againstGrain(state, p.id, p.level).against) delta(state, 'unrest', GRAIN_UNREST, `${source}:grain`);
  }
}

// Returns the coin due this year; the economy debits it.
export function policiesYearly(state) {
  const byRule = {};
  for (const p of activePolicies(state)) byRule[p.id] = upkeepFor(state, p.id, p.level);
  const total = Object.values(byRule).reduce((a, b) => a + b, 0);
  return {total, byRule};
}

// Multipliers and additive values other modules read. Defaults: mul 1, add 0.
export function policyModifiers(state) {
  const mods = {mul: {}, add: {}};
  for (const p of activePolicies(state)) {
    for (const [k, v] of Object.entries(p.def.mul ?? {})) mods.mul[k] = (mods.mul[k] ?? 1) * atLevel(v, p.level);
    for (const [k, v] of Object.entries(p.def.add ?? {})) mods.add[k] = (mods.add[k] ?? 0) + atLevel(v, p.level);
  }
  mods.get = (k) => mods.mul[k] ?? 1;
  mods.sum = (k) => mods.add[k] ?? 0;
  return mods;
}

// Option weight multipliers for one question kind: {option: multiplier}.
// Cached per tick and Rule Book version (adoptPolicy bumps it).
const weightCache = new WeakMap();
export function weightsFor(state, kindId) {
  const key = `${state.time?.tick}:${state.governance?.rulesRev ?? 0}`;
  let entry = weightCache.get(state);
  if (entry?.key !== key) weightCache.set(state, (entry = {key, kinds: {}}));
  return (entry.kinds[kindId] ??= computeWeights(state, kindId));
}

function computeWeights(state, kindId) {
  const out = {};
  const prefix = `${kindId}.`;
  for (const p of activePolicies(state)) {
    for (const [key, v] of Object.entries(p.def.weights ?? {})) {
      if (!key.startsWith(prefix)) continue;
      const option = key.slice(prefix.length);
      const w = Array.isArray(v) ? atLevel(v, p.level) : 1 + (v - 1) * p.level;
      out[option] = (out[option] ?? 1) * w;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tensions: open pairs, plus rules whose pushes on a trait nearly cancel.
// ---------------------------------------------------------------------------

function monthlyTraitPush(p, trait) {
  return atLevel(p.def.deltas?.[trait] ?? 0, p.level);
}

export function detectTensions(state) {
  const active = activePolicies(state);
  const found = new Map();
  const add = (a, b, why, trait = null) => {
    const [left, right] = [a.id, b.id].sort();
    const key = `${left}|${right}`;
    if (!found.has(key)) found.set(key, {id: key, left, right, why, trait});
  };
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i], b = active[j];
      if (a.def.tensions?.includes(b.id) || b.def.tensions?.includes(a.id)) {
        add(a, b, 'open');
        continue;
      }
      for (const k of TRAITS) {
        const da = monthlyTraitPush(a, k), db = monthlyTraitPush(b, k);
        if (!da || !db || Math.sign(da) === Math.sign(db)) continue;
        if (Math.abs(da + db) < 0.3 * Math.max(Math.abs(da), Math.abs(db))) add(a, b, 'cancel', k);
      }
    }
  }
  return [...found.values()];
}

export function tensionText(t) {
  const left = POLICIES[t.left]?.title ?? t.left;
  const right = POLICIES[t.right]?.title ?? t.right;
  return fill('Two of your rules pull against each other: {left} and {right}. Nothing moves while both stand.',
    {left: left.toLowerCase(), right: right.toLowerCase()});
}

// Rules that touch one trade, for faction stances and proposal snapshots.
export function rulesTouching(trade) {
  return POLICY_IDS.filter((id) => POLICIES[id].helps?.includes(trade) || POLICIES[id].hurts?.includes(trade));
}
