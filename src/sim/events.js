// Events: floods, fires, fairs, strikes, booms and busts (design-systems §8).
//
// Each event has a `when` condition, a monthly `chance`, a cooldown in years,
// optional choices (an 'event' docket card; the first choice is the default if
// the card expires), effects on the town, and something to see: entries in
// state.worldEvents with a position, so the renderer can draw crowds, banners,
// fire and floodwater.
//
// worldEvents times (t0, t1) are absolute month indices (monthIndex(state.time)),
// which is what walkers read to join or flee them.

import {holds, makeCtx} from './conditions.js';
import {rng, rngInt} from './rng.js';
import {monthIndex} from './clock.js';
import {setTag, touchBuilding} from './state.js';
import {riverX, heightAt, waterAt, terrainSeed} from '../terrain.js';
import {policyModifiers, levelOf, costScale} from './policies.js';
import {fill, coin} from './text/voice.js';
import {addChronicle} from './chronicle.js';
import {addCard, makeCard, applyEffects} from './docket.js';
import * as bodies from './institutions.js';
import {killShare, immigrate} from './households.js';
import {closeEnterprise} from './enterprises.js';
import {pay} from './economy.js';
import {floodPoint, fireBlock, floodRisk} from './sites.js';
import {eventResponseRequested} from './decisions/scheduler.js';
import {tellStory} from './decisions/effects.js';
import {findHook} from './hooks.js';
import {subjectOpen} from './subjects.js';
import {bridgeCollapseRisk} from './bridges.js';

const SPRING = ['lte', 'month', 2];
const SUMMER = ['between', 'month', 3, 5];
const AUTUMN = ['between', 'month', 6, 8];

// lapse: the status-quo choice if the card is never read (no new rules).
// titleCard: a major moment the UI may show as a title card.
// Effects: generic card effects (deltas, tag, spend, food, policy, build) plus
// event ops: pop, migrants, damage, crowd, mods, schedule, offer, patience.
export const EVENTS = {
  flood: {
    title: 'The river floods', icon: 'wave',
    titleCard: true,
    lapse: 'households',
    when: ['and', SPRING, ['or', ['lte', 'P.ecology', 0.8], ['not', ['has', 'policy', 'riverbank-protect']]]],
    chance: (s, m) => 0.02 * m.get('floodChance') * (levelOf(s, 'riverbank-protect') ? 0.5 : 1) * (1.6 - s.pressures.ecology),
    cooldown: 4,
    why: 'The river has burst its banks. Homes by the water stand knee-deep.',
    effects: [
      {deltas: {riverTrade: -0.05, unrest: 0.03}}, {tag: 'flood'}, {food: -0.1},
      {damage: {at: 'river', radius: 14, condition: -0.4, mul: 'floodDamage'}},
      {crowd: {kind: 'flood', at: 'river', radius: 26, months: 2, strength: 0.9}},
    ],
    response: true,
    choices: [
      {key: 'rebuild', label: 'Rebuild at the town\'s cost', tradeoff: 'It costs {cost}. Families are back home by summer.', cost: 400,
        effects: [{spend: 'cost'}, {deltas: {unrest: -0.03}}]},
      {key: 'households', label: 'Let families rebuild', tradeoff: 'No cost to the town. Poor families struggle.',
        effects: [{deltas: {unrest: 0.02}}]},
      {key: 'relocate', label: 'Move the lowest street uphill', tradeoff: 'It costs {cost}. The next flood will do less harm.', cost: 700,
        effects: [{spend: 'cost'}, {tag: 'relocated-street'}, {deltas: {authority: 0.02}}]},
    ],
  },
  'bumper-harvest': {
    title: 'A bumper harvest', icon: 'wheat',
    when: ['and', AUTUMN, ['gte', 'C.farm', 2], ['gte', 'P.ecology', 0.5]],
    chance: () => 0.08, cooldown: 2,
    line: 'Good news. The harvest came in heavy. The barns are full.',
    effects: [{food: 0.25}, {deltas: {unrest: -0.01}}, {mood: {trades: ['farm'], amount: 0.06}},
      {crowd: {kind: 'festival', at: 'farm', radius: 10, months: 1, strength: 0.4}}],
  },
  blight: {
    title: 'Blight in the fields', icon: 'wheat',
    lapse: 'nothing',
    when: ['and', ['gte', 'C.farm', 8], ['lte', 'I.foodBalance', 5]],
    chance: (s, m) => 0.03 * m.get('famineChance'), cooldown: 6,
    why: 'Here is the problem. A blight has struck the grain. A third of the crop is lost.',
    effects: [{food: -0.3}, {deltas: {unrest: 0.04}}, {tag: 'blight'}],
    response: true,
    choices: [
      {key: 'import', label: 'Buy grain from the boats', tradeoff: 'It costs {cost}. No one goes hungry.', cost: 500,
        effects: [{spend: 'cost'}, {food: 0.2}, {deltas: {riverTrade: 0.01}}]},
      {key: 'fast', label: 'Call fast days', tradeoff: 'No cost. Food lasts longer. Faith grows, and so does hunger.',
        effects: [{policy: 'fast-days', level: 1}, {deltas: {faith: 0.02}}]},
      {key: 'nothing', label: 'Wait for next year', tradeoff: 'No cost. Some families will leave.',
        effects: [{pop: -0.03, reason: 'hunger'}, {deltas: {unrest: 0.03}}]},
    ],
  },
  fire: {
    title: 'Fire in the old streets', icon: 'flame',
    titleCard: true,
    lapse: 'same',
    when: ['and', ['gte', 'I.density', 0.45], ['lte', 'era', 3]],
    chance: (s) => 0.015 * (s.indicators.density ?? 0) * timberShare(s) * 2, cooldown: 3,
    why: 'Fire swept through the wooden houses last night. Several homes are ash.',
    effects: [{damage: {at: 'timber', radius: 10, condition: -1, count: [3, 12]}}, {deltas: {health: -0.05, unrest: 0.02}}, {tag: 'fire'},
      {crowd: {kind: 'fire', at: 'timber', radius: 12, months: 1, strength: 1}}],
    response: true,
    choices: [
      {key: 'brick', label: 'Rebuild in brick', tradeoff: 'It costs {cost}. Fire will not spread so fast again.', cost: 600,
        effects: [{spend: 'cost'}, {tag: 'brick-rule'}, {deltas: {innovation: 0.01}}]},
      {key: 'same', label: 'Rebuild as before', tradeoff: 'Cheap and quick. The risk stays.',
        effects: []},
      {key: 'newcomers', label: 'Open the lots to newcomers', tradeoff: 'New families come. Old ones may not return.',
        effects: [{migrants: 0.02, kind: 'poor-family'}, {deltas: {unrest: 0.01}}]},
    ],
  },
  plague: {
    title: 'Plague', icon: 'cross',
    titleCard: true,
    lapse: 'pray',
    when: ['and', ['gte', 'I.pop', 500], ['lte', 'P.health', 0.4]],
    chance: (s) => 0.01 * (1 - s.pressures.health) * 1.5, cooldown: 15,
    why: 'Plague has come. Doors are shut and bells toll every day.',
    effects: [{pop: -0.08, reason: 'plague', mul: 'plagueDeaths'}, {deltas: {health: -0.1, unrest: 0.05}}, {tag: 'plague'},
      {crowd: {kind: 'funeral', at: 'chapel', radius: 8, months: 3, strength: 0.6}},
      {banner: {type: 'home', value: 'plague', share: 0.15, months: 6}}],
    response: true,
    choices: [
      {key: 'quarantine', label: 'Close the sick houses', tradeoff: 'Fewer die. The shut-in families grow angry.',
        effects: [{pop: 0.03, reason: 'spared'}, {deltas: {unrest: 0.05}}]},
      {key: 'infirmary', label: 'Open a house for the sick', tradeoff: 'It costs {cost}. Healers save many.', cost: 600,
        effects: [{spend: 'cost'}, {pop: 0.04, reason: 'spared'}, {build: 'infirmary'}]},
      {key: 'pray', label: 'Pray together', tradeoff: 'No cost. Faith grows. The sickness runs its course.',
        effects: [{deltas: {faith: 0.06}}]},
    ],
  },
  fair: {
    title: 'The summer fair', icon: 'tent',
    lapse: 'allow', recall: 3,
    when: ['and', SUMMER, ['or', ['has', 'institution', 'arts-society'], ['has', 'policy', 'market-charter'], ['has', 'policy', 'festival-fund']]],
    chance: () => 0.25, cooldown: 1,
    why: 'Traders want to hold a fair on the green. Shall the town help?',
    effects: [{tag: 'fair'}, {crowd: {kind: 'festival', at: 'square', radius: 16, months: 1, strength: 0.8}}],
    participation: true,
    choices: [
      {key: 'fund', label: 'Fund it well', tradeoff: 'It costs {cost}. Visitors flock in.', cost: 250,
        effects: [{spend: 'cost'}, {deltas: {prestige: 0.03, unrest: -0.02}}, {migrants: 0.01, kind: 'visitors'}]},
      {key: 'allow', label: 'Let them hold it', tradeoff: 'No cost. A modest fair.',
        effects: [{deltas: {prestige: 0.01}}]},
      {key: 'refuse', label: 'Keep the green quiet', tradeoff: 'No fair this year. Traders go elsewhere.',
        effects: [{deltas: {prestige: -0.01, market: -0.01}}, {cancelCrowd: true}]},
    ],
  },
  'feast-day': {
    title: 'A feast day', icon: 'bell',
    when: ['and', ['has', 'institution', 'parish'], ['has', 'policy', 'feast-days'], ['eq', 'month', 4]],
    chance: () => 1, cooldown: 1,
    line: 'The town kept the feast. A procession wound along the main road.',
    effects: [{tag: 'feast-day'}, {deltas: {faith: 0.01, unrest: -0.01}},
      {crowd: {kind: 'procession', at: 'chapel', radius: 20, months: 1, strength: 0.7}}],
    participation: true,
  },
  strike: {
    title: 'The workers strike', icon: 'fist',
    lapse: 'owners',
    when: ['and', ['has', 'institution', 'union'], ['gte', 'P.unrest', 0.3], ['lte', 'I.inequality', 1]],
    chance: (s) => 0.1 * (holds(['torn', 'react_to_policy', 'trade', 'district', 0.25, 30], makeCtx(s)) ? 1.5 : 1),
    cooldown: 3,
    why: 'The mill hands have walked out. They want better pay. The chimneys are cold.',
    effects: [{tag: 'strike'}, {mods: {output: 0.6}, months: 2},
      {crowd: {kind: 'strike', at: 'mill', radius: 10, months: 2, strength: 0.9, faction: 'labourers'}}],
    vote: true,
    choices: [
      {key: 'workers', label: 'Side with the workers', tradeoff: 'Pay rises. The owners are furious.',
        effects: [{policy: 'wage-floor', level: '+1'}, {mood: {trades: ['labour'], amount: 0.1}}, {mood: {trades: ['gentry'], amount: -0.1}}]},
      {key: 'owners', label: 'Side with the owners', tradeoff: 'The watch clears the gates. Anger grows.',
        effects: [{deltas: {unrest: 0.05, authority: 0.02}}, {mood: {trades: ['labour'], amount: -0.12}}]},
      {key: 'mediate', label: 'Bring both sides together', tradeoff: 'It costs {cost}. Both give a little.', cost: 300,
        effects: [{spend: 'cost'}, {deltas: {unrest: -0.04}}]},
    ],
  },
  'migration-wave': {
    title: 'Newcomers at the gate', icon: 'cart', manual: true,
    lapse: 'quota',
    why: 'Carts are coming up the road. Families from the hills want to settle here.',
    effects: [{crowd: {kind: 'procession', at: 'entry', radius: 10, months: 1, strength: 0.5}}],
    choices: [
      {key: 'welcome', label: 'Welcome them all', tradeoff: 'The town grows fast. Homes will be scarce.',
        effects: [{migrants: 0.07, kind: 'mixed'}]},
      {key: 'quota', label: 'Take half', tradeoff: 'Slower growth. Some families turn back.',
        effects: [{migrants: 0.035, kind: 'mixed'}]},
      {key: 'away', label: 'Turn them away', tradeoff: 'Fewer mouths. Our name suffers.',
        effects: [{deltas: {prestige: -0.03, unrest: -0.01}}]},
    ],
  },
  exodus: {
    title: 'Families leave', icon: 'cart', manual: true,
    when: ['lte', 'I.wellbeing', 30],
    chance: () => 0.05, cooldown: 5,
    line: 'Here is hard news. Families are packing their carts and leaving town.',
    effects: [{pop: -0.05, reason: 'exodus'}, {tag: 'exodus'},
      {crowd: {kind: 'procession', at: 'entry', radius: 8, months: 1, strength: 0.4}}],
  },
  'discovery-clay': {
    title: 'Good clay by the stream', icon: 'pick', once: true,
    lapse: 'leave',
    when: ['era', 1], chance: () => 0.01,
    why: 'Diggers found fine clay by the stream. It would make good bricks.',
    effects: [{tag: 'clay'}, {crowd: {kind: 'market', at: 'hill', radius: 8, months: 1, strength: 0.4}}],
    choices: [
      {key: 'open', label: 'Open a brick kiln', tradeoff: 'Bricks for the town. Smoke by the stream.',
        effects: [{deltas: {industry: 0.03, ecology: -0.02}}, {build: 'workshop', variant: 'kiln', at: 'hill'}]},
      {key: 'guild', label: 'Let the guild run it', tradeoff: 'The makers grow richer and stronger.',
        effects: [{deltas: {industry: 0.015, market: -0.01}}, {patience: {body: 'trades-guild', amount: 0.2}}]},
      {key: 'leave', label: 'Leave it be', tradeoff: 'The stream stays clear.', effects: [{deltas: {ecology: 0.01}}]},
    ],
  },
  'discovery-coal': {
    title: 'Coal in the hills', icon: 'pick', once: true,
    lapse: 'leave',
    when: ['and', ['era', 2], ['gte', 'T.industry', 0.2]], chance: () => 0.01,
    why: 'There is coal in the north hills. It could fire a dozen engines.',
    effects: [{tag: 'coal'}, {crowd: {kind: 'market', at: 'hill', radius: 8, months: 1, strength: 0.4}}],
    choices: [
      {key: 'open', label: 'Open a coal pit', tradeoff: 'Work and power for the mills. Black skies.',
        effects: [{deltas: {industry: 0.08, ecology: -0.05}}, {build: 'workshop', variant: 'coal-pit', at: 'hill'}]},
      {key: 'guild', label: 'License it to the owners', tradeoff: 'Coin for the town. The owners grow rich.',
        effects: [{deltas: {industry: 0.04, market: 0.02}}, {spend: -300}]},
      {key: 'leave', label: 'Leave the hills green', tradeoff: 'Nothing changes.', effects: [{deltas: {ecology: 0.01}}]},
    ],
  },
  'discovery-quarry': {
    title: 'Good stone in the hills', icon: 'pick', once: true, lapse: 'leave',
    when: ['and', ['era', 1], ['gte', 'I.pop', 150]], chance: () => 0.01,
    why: 'Masons found fine building stone on the high ground. It would last for centuries.',
    effects: [{tag: 'quarry'}, {crowd: {kind: 'market', at: 'hill', radius: 8, months: 1, strength: 0.4}}],
    choices: [
      {key: 'open', label: 'Open a quarry', tradeoff: 'Stone for the town. Scars on the hill.',
        effects: [{deltas: {industry: 0.02, prestige: 0.02, ecology: -0.02}}, {build: 'quarry', at: 'hill'}]},
      {key: 'guild', label: 'Let the masons run it', tradeoff: 'The makers grow stronger. A little coin for the town.',
        effects: [{spend: -150}, {patience: {body: 'trades-guild', amount: 0.15}}]},
      {key: 'leave', label: 'Leave the hill alone', tradeoff: 'The skyline stays green.', effects: [{deltas: {ecology: 0.01}}]},
    ],
  },
  'discovery-spring': {
    title: 'A warm spring', icon: 'drop', once: true,
    lapse: 'leave',
    when: ['gte', 'P.ecology', 0.7], chance: () => 0.01,
    why: 'Shepherds found a warm spring in the meadow. People say it heals.',
    effects: [{tag: 'spring'}],
    choices: [
      {key: 'open', label: 'Build a bathhouse', tradeoff: 'It costs {cost}. Visitors will come to bathe.', cost: 500,
        effects: [{spend: 'cost'}, {build: 'bathhouse'}, {deltas: {prestige: 0.03, health: 0.02}}]},
      {key: 'guild', label: 'Sell the rights', tradeoff: 'Coin now. A merchant keeps the profits.',
        effects: [{spend: -250}, {deltas: {market: 0.02}}]},
      {key: 'leave', label: 'Leave it wild', tradeoff: 'The meadow stays as it is.', effects: [{deltas: {ecology: 0.01}}]},
    ],
  },
  schism: {
    title: 'A quarrel in the church', icon: 'bell',
    lapse: 'chapter',
    when: ['and', ['has', 'institution', 'parish'], ['gte', 'P.faith', 0.5], ['gte', 'T.innovation', 0.3]],
    chance: (s) => 0.02 * (holds(['torn', 'festival_participation', 'district', 'faithBand', 0.3, 30], makeCtx(s)) ? 2 : 1),
    cooldown: 20,
    why: 'Reformers want plainer services. The old chapter says no. The faithful are split.',
    effects: [{deltas: {faith: -0.05}}, {tag: 'schism'}, {split: 'clergy'},
      {crowd: {kind: 'procession', at: 'chapel', radius: 14, months: 1, strength: 0.6}}],
    choices: [
      {key: 'tolerate', label: 'Let both worship', tradeoff: 'A second chapel goes up. Peace returns slowly.',
        effects: [{build: 'chapel', at: 'hill'}, {deltas: {faith: 0.04, innovation: 0.01}}]},
      {key: 'chapter', label: 'Side with the old chapter', tradeoff: 'Tradition holds. Reformers may leave.',
        effects: [{deltas: {innovation: -0.03, faith: 0.02}}, {pop: -0.01, reason: 'reformers leave'}]},
      {key: 'reformers', label: 'Side with the reformers', tradeoff: 'New ideas win. The chapter is bitter.',
        effects: [{deltas: {innovation: 0.04}}, {patience: {body: 'parish', amount: -0.2}}]},
    ],
  },
  boom: {
    title: 'A trading boom', icon: 'scales',
    when: ['and', ['has', 'institution', 'exchange'], ['gte', 'C.speculating', 1]],
    chance: () => 0.05, cooldown: 8,
    line: 'Good news, for now. Trade is booming. Cranes rise over the quays.',
    effects: [{tag: 'boom'}, {cash: 0.3}, {deltas: {market: 0.03}}, {inequality: 0.05}, {schedule: {event: 'bust', years: [5, 10]}},
      {crowd: {kind: 'market', at: 'exchange', radius: 14, months: 3, strength: 0.6}}],
  },
  bust: {
    title: 'The bubble bursts', icon: 'scales', manual: true,
    titleCard: true,
    lapse: 'fail',
    test: (s) => rng(s) < 0.5 + 0.4 * (s.indicators.inequality ?? 0),
    why: 'The boom is over. Merchants cannot pay their debts. Shutters are coming down.',
    effects: [{tag: 'bust'}, {close: 0.2}, {deltas: {unrest: 0.1}}, {pop: -0.02, reason: 'bust'},
      {crowd: {kind: 'protest', at: 'exchange', radius: 12, months: 2, strength: 0.8, faction: 'merchants'}}],
    response: true,
    choices: [
      {key: 'bail', label: 'Bail out the Exchange', tradeoff: 'The town borrows to save the merchants.',
        effects: [{loan: 1200}, {deltas: {unrest: -0.04}}, {mood: {trades: ['labour'], amount: -0.08}}]},
      {key: 'fail', label: 'Let it fail', tradeoff: 'Debts are wiped out the hard way. Many lose everything.',
        effects: [{deltas: {market: -0.04, unrest: 0.03}}]},
      {key: 'works', label: 'Put people to work on the roads', tradeoff: 'It costs {cost}. Roads improve and wages flow.', cost: 600,
        effects: [{spend: 'cost'}, {deltas: {unrest: -0.05, authority: 0.02}}, {offer: 'pave-lane'}]},
    ],
  },
  'royal-visit': {
    title: 'A royal visit', icon: 'crown',
    titleCard: true,
    lapse: 'decline',
    when: ['gte', 'P.prestige', 0.5],
    chance: () => 0.02, cooldown: 25,
    why: 'The queen will pass through on her summer tour. She could stay a night.',
    effects: [{tag: 'royal-visit'}],
    choices: [
      {key: 'host', label: 'Host her in style', tradeoff: 'It costs {cost}. Our name will be known far and wide.', cost: 800,
        effects: [{spend: 'cost'}, {deltas: {prestige: 0.1}}, {offer: 'monument'},
          {crowd: {kind: 'procession', at: 'square', radius: 24, months: 1, strength: 1}}]},
      {key: 'decline', label: 'Send our regrets', tradeoff: 'No cost. A chance passes by.',
        effects: [{deltas: {prestige: -0.02}}]},
    ],
  },
  drought: {
    title: 'Drought', icon: 'sun',
    lapse: 'ration',
    when: ['and', SUMMER, ['lte', 'P.ecology', 0.6]],
    chance: () => 0.03, cooldown: 4,
    why: 'No rain for weeks. The river is low and the fields are brown.',
    effects: [{tag: 'drought'}, {food: -0.15}, {mods: {millOutput: 0.8}, months: 3}],
    response: true,
    choices: [
      {key: 'ration', label: 'Ration the water', tradeoff: 'No cost. Everyone goes a little thirsty.',
        effects: [{deltas: {unrest: 0.02}}]},
      {key: 'wells', label: 'Dig new wells', tradeoff: 'It costs {cost}. Health holds.', cost: 400,
        effects: [{spend: 'cost'}, {policy: 'wells', level: '+1'}]},
    ],
  },
  'bridge-collapse': {
    title: 'The old bridge falls', icon: 'bridge',
    titleCard: true,
    lapse: 'ferry',
    when: ['gt', 'C.bridgeRisk', 0],
    // Worn and overloaded bridges fall: sim-world's yearly risk, taken monthly.
    chance: (s) => 1 - (1 - Math.min(0.95, bridgeRisk(s))) ** (1 / 12), cooldown: 10,
    why: 'The old timber bridge gave way this morning. The river cuts the town in two.',
    effects: [{fallen: true}, {tag: 'bridge-collapse'}, {deltas: {riverTrade: -0.03, unrest: 0.02}},
      {crowd: {kind: 'protest', at: 'river', radius: 10, months: 1, strength: 0.5}}],
    // The bridge that fell closes (sim-world). The choice rebuilds it; the ferry
    // leaves it down. While this card is open, and for a while after, no
    // separate bridge-works card asks about it again.
    subjects: ['work:bridge-upgrade'],
    choices: [
      {key: 'stone', label: 'Rebuild in stone', tradeoff: 'It costs {cost}. It will stand for centuries.', cost: 1800,
        effects: [{spend: 'cost'}, {deltas: {prestige: 0.02}}, {rebuild: 'stone'}]},
      {key: 'timber', label: 'Rebuild in timber', tradeoff: 'It costs {cost}. Cheap, but it will rot again.', cost: 600,
        effects: [{spend: 'cost'}, {rebuild: 'timber'}]},
      {key: 'ferry', label: 'Run a ferry instead', tradeoff: 'No cost. Slower crossings.',
        effects: [{tag: 'ferry'}, {deltas: {riverTrade: 0.005}}]},
    ],
  },
  riot: {
    title: 'Riot', icon: 'flame',
    titleCard: true,
    lapse: 'watch',
    when: ['gte', 'P.unrest', 0.7],
    chance: (s) => 0.2 * (1 + (s.indicators.tension ?? 0)), cooldown: 5,
    why: 'An angry crowd has filled the square. Windows are broken. Torches are lit.',
    effects: [{tag: 'riot'}, {damage: {at: 'square', radius: 12, condition: -0.2}}, {deltas: {prestige: -0.1}},
      {crowd: {kind: 'protest', at: 'square', radius: 18, months: 1, strength: 1}}],
    response: true,
    choices: [
      {key: 'concede', label: 'Give them what they want', tradeoff: 'Calm returns. They learn that riots work.',
        effects: [{deltas: {unrest: -0.25, authority: -0.03}}, {concede: true}]},
      {key: 'watch', label: 'Send in the watch', tradeoff: 'The square is cleared. Bitterness lingers for years.',
        effects: [{deltas: {unrest: -0.3, authority: 0.05}}, {mods: {unrestDrift: 0.01}, months: 24}]},
      {key: 'moot', label: 'Call an open moot', tradeoff: 'Everyone may speak. The council shares its power.',
        effects: [{policy: 'open-moot', level: 1}, {deltas: {unrest: -0.15}}]},
    ],
  },
  'scholar-arrives': {
    title: 'A scholar arrives', icon: 'book',
    lapse: 'welcome',
    when: ['gte', 'P.learning', 0.3],
    chance: () => 0.03, cooldown: 10,
    why: 'A famous scholar has come to town. She would stay if we give her a college.',
    effects: [{tag: 'scholar'}],
    choices: [
      {key: 'college', label: 'Found a college', tradeoff: 'It costs {cost}. Learning will flourish.', cost: 1200,
        effects: [{spend: 'cost'}, {build: 'school', variant: 'college'}, {deltas: {learning: 0.08, innovation: 0.04, prestige: 0.03}}]},
      {key: 'welcome', label: 'Welcome her as a guest', tradeoff: 'No cost. She teaches for a season.',
        effects: [{deltas: {learning: 0.03, innovation: 0.01}}]},
    ],
  },
  'founders-jubilee': {
    title: 'The founders\' jubilee', icon: 'star',
    titleCard: true,
    lapse: 'quiet',
    test: (s) => (s.time.year === 50 || s.time.year === 100) && s.time.month === 4,
    chance: () => 1, cooldown: 40,
    why: 'Hearthvale is {years} years old. The town wants to mark the day.',
    effects: [{tag: 'jubilee'}],
    choices: [
      {key: 'festival', label: 'Throw a great festival', tradeoff: 'It costs {cost}. A day to remember.', cost: 400,
        effects: [{spend: 'cost'}, {deltas: {prestige: 0.04, unrest: -0.05}},
          {crowd: {kind: 'festival', at: 'square', radius: 26, months: 1, strength: 1}}]},
      {key: 'quiet', label: 'Keep it quiet', tradeoff: 'A prayer and a bell. No cost.',
        effects: [{deltas: {faith: 0.01}}]},
    ],
  },
  barges: {
    title: 'Barges from the coast', icon: 'wave',
    lapse: 'pass',
    when: ['and', ['gte', 'P.riverTrade', 0.3], ['or', ['gte', 'C.quay', 1], ['tag', 'ferry'], ['gte', 'C.bridge', 1]]],
    chance: () => 0.04, cooldown: 6,
    why: 'Big barges from the coast want to make Hearthvale a regular stop.',
    effects: [{tag: 'barges'}, {crowd: {kind: 'market', at: 'river', radius: 14, months: 2, strength: 0.6}}],
    choices: [
      {key: 'welcome', label: 'Welcome them', tradeoff: 'Trade booms on the river. Prices fall for some.',
        effects: [{deltas: {riverTrade: 0.05, market: 0.02}}]},
      {key: 'charge', label: 'Charge a mooring fee', tradeoff: 'Coin for the town. Fewer barges stay.',
        effects: [{spend: -150}, {deltas: {riverTrade: 0.02}}]},
      {key: 'pass', label: 'Let them pass by', tradeoff: 'Nothing changes on the river.', effects: []},
    ],
  },
  'press-arrives': {
    title: 'A printing press', icon: 'book', once: true,
    lapse: 'ban',
    when: ['and', ['era', 3], ['gte', 'P.learning', 0.3]], chance: () => 0.05,
    why: 'A printer has brought a press to town. He wants to print a weekly paper.',
    effects: [{tag: 'press'}],
    choices: [
      {key: 'licence', label: 'Grant a licence', tradeoff: 'News and new ideas spread. So does grumbling.',
        effects: [{policy: 'press-licence', level: 1}, {deltas: {innovation: 0.05, learning: 0.04}}]},
      {key: 'ban', label: 'Ban the press', tradeoff: 'Order holds. New ideas stay out.',
        effects: [{deltas: {authority: 0.03, innovation: -0.03}}]},
    ],
  },
};

for (const [id, e] of Object.entries(EVENTS)) e.id = id;

export const EVENT_IDS = Object.keys(EVENTS);

// ---------------------------------------------------------------------------
// Places for crowds and damage
// ---------------------------------------------------------------------------

function timberShare(state) {
  let timber = 0, all = 0;
  for (const b of state.buildings) {
    if (b.type !== 'home') continue;
    all++;
    if (b.material === 'timber' || b.material === 'thatch') timber++;
  }
  return all ? timber / all : 0;
}

function townCentre(state) {
  const d = state.districts?.[0]?.centroid;
  if (d) return {x: d.x, z: d.z};
  const moot = state.buildings.find((b) => b.type === 'moot');
  return moot ? {x: moot.x, z: moot.z} : {x: 0, z: 0};
}

const firstOfType = (state, types) => state.buildings.find((b) => types.includes(b.type) && (b.built ?? 1) >= 1);

// The densest cluster of timber homes, by a cheap grid count.
function timberCluster(state) {
  const cells = new Map();
  let best = null;
  for (const b of state.buildings) {
    if (b.type !== 'home' || !(b.material === 'timber' || b.material === 'thatch')) continue;
    const key = `${Math.floor(b.x / 16)},${Math.floor(b.z / 16)}`;
    const n = (cells.get(key) ?? 0) + 1;
    cells.set(key, n);
    if (!best || n > best.n || (n === best.n && key < best.key)) best = {key, n, x: b.x, z: b.z};
  }
  return best ?? townCentre(state);
}

// The highest dry ground within reach of town (sampled on a coarse grid;
// cached per terrain seed and town centre).
const hillCache = new Map();
export function highPoint(state, radius = 90) {
  const c = townCentre(state);
  const key = `${terrainSeed?.() ?? 0}:${Math.round(c.x / 8)}:${Math.round(c.z / 8)}`;
  if (hillCache.has(key)) return hillCache.get(key);
  let best = {x: c.x, z: c.z, h: -Infinity};
  for (let dz = -radius; dz <= radius; dz += 6) {
    for (let dx = -radius; dx <= radius; dx += 6) {
      if (dx * dx + dz * dz > radius * radius) continue;
      const x = c.x + dx, z = c.z + dz;
      if (waterAt(x, z)) continue;
      const h = heightAt(x, z);
      if (h > best.h) best = {x, z, h};
    }
  }
  const point = {x: Math.round(best.x), z: Math.round(best.z), radius: 10};
  if (hillCache.size > 32) hillCache.clear();
  hillCache.set(key, point);
  return point;
}

export function placeFor(state, at) {
  const c = townCentre(state);
  if (String(at).startsWith('centre:')) {
    const centre = (state.centres ?? []).find((x) => x.id === Number(String(at).split(':')[1]));
    if (centre) return {x: centre.x, z: centre.z, radius: 12};
  }
  switch (at) {
    case 'river': return state.buildings.length ? floodPoint(state) : {x: riverX(c.z) - 7, z: c.z};
    case 'timber': return fireBlock(state) ?? timberCluster(state);
    case 'farm': return firstOfType(state, ['farm']) ?? c;
    case 'chapel': return firstOfType(state, ['chapel']) ?? firstOfType(state, ['moot']) ?? c;
    case 'mill': return firstOfType(state, ['mill', 'factory', 'workshop']) ?? c;
    case 'exchange': return firstOfType(state, ['exchange', 'market']) ?? c;
    case 'square': return firstOfType(state, ['market', 'moot']) ?? c;
    case 'hill': return highPoint(state);
    case 'entry': {
      const away = c.x < riverX(c.z) ? -1 : 1;
      return {x: c.x + away * 60, z: c.z + 10};
    }
    default: return firstOfType(state, ['moot']) ?? c;
  }
}

// ---------------------------------------------------------------------------
// Monthly roll
// ---------------------------------------------------------------------------

// The bridge most likely to fall. Only a worn bridge falls.
export const COLLAPSE_CONDITION = 0.5;
const fragile = (b) => b.type === 'bridge' && (b.condition ?? 1) < COLLAPSE_CONDITION;

function riskiestBridge(state) {
  let best = null, risk = 0;
  for (const b of state.buildings) {
    if (!fragile(b)) continue;
    const r = bridgeCollapseRisk(state, b);
    if (r > risk) [best, risk] = [b, r];
  }
  return best;
}

// sim-world closes the deck (collapsed, no longer crossed or drawn); the ford reopens.
function closeFallenBridge(state) {
  const b = riskiestBridge(state);
  if (!b) return null;
  const done = findHook('collapseBridge')?.(state, b);
  return done?.ok === false ? null : b.id;
}

// Rebuild the fallen bridge (sim-world: 'stone' builds a new deck in place of
// the ruin, 'timber' rebuilds the old one), already paid for by the event's choice.
function rebuildBridge(state, bridgeId, how) {
  if (bridgeId == null) return;
  findHook('rebuildBridge')?.(state, bridgeId, how === 'stone' ? 'stone' : 'timber', {payer: 'treasury', paid: true});
}

// The yearly chance that some worn bridge in town gives way (sim-world's
// bridgeCollapseRisk: 0.08 × wear × overload (capped at 2), per bridge).
export function bridgeRisk(state) {
  let standing = 1;
  for (const b of state.buildings) {
    if (!fragile(b)) continue;
    standing *= 1 - Math.min(1, bridgeCollapseRisk(state, b));
  }
  return 1 - standing;
}

// Counts the event conditions need beyond sim-core's C.* table.
function extendCounts(state, ctx) {
  const spec = state.governance?.sliceAnswers?.merchant_speculate;
  let invest = 0;
  for (const key in spec ?? {}) invest += (spec[key].probs?.invest_build ?? 0) + (spec[key].probs?.invest_trade ?? 0);
  const n = Object.keys(spec ?? {}).length;
  ctx.C.speculating = n && invest / n >= 0.6 ? 1 : 0;
  ctx.C.bridgeRisk = bridgeRisk(state);
}

export function eventsMonthly(state) {
  const year = state.time.year;
  const m = monthIndex(state.time);
  const ctx = makeCtx(state);
  extendCounts(state, ctx);
  const mods = policyModifiers(state);
  // End finished events and their crowds.
  state.events.active = state.events.active.filter((a) => a.endsMonth > m);
  state.worldEvents = state.worldEvents.filter((w) => w.t1 == null || w.t1 > m);
  for (const b of state.buildings) {
    if (b.banner && b.bannerUntil != null && b.bannerUntil <= m) {
      b.banner = null;
      b.bannerUntil = null;
      touchBuilding(state, b);
    }
  }
  // Scheduled events (a bust after a boom).
  for (const s of [...(state.events.scheduled ?? [])]) {
    if (s.month > m) continue;
    state.events.scheduled.splice(state.events.scheduled.indexOf(s), 1);
    const def = EVENTS[s.event];
    if (def && (!def.test || def.test(state))) fireEvent(state, s.event, {force: true});
  }
  for (const id of EVENT_IDS) {
    const def = EVENTS[id];
    if (def.manual && !def.when) continue;
    if ((state.events.cooldownUntil[id] ?? -1) > year) continue;
    if (def.once && state.tags[`event:${id}`] != null) continue;
    if (subjectOpen(state, `event:${id}`)) continue;
    if (def.test && !def.test(state)) continue;
    if (def.when && !holds(def.when, ctx)) continue;
    const p = def.chance ? def.chance(state, mods) : 1;
    if (rng(state) < p) fireEvent(state, id);
  }
}

// Fire an event now. With a choice, apply it straight away (no card).
// Whatever sets it off (the calendar, angry workers, a plan), an event waits
// out its cooldown and never fires while the same thing is on the docket,
// unless a choice was made for it or it was scheduled (force).
export function fireEvent(state, id, {choice = null, from = null, force = false} = {}) {
  const def = EVENTS[id];
  if (!def) return null;
  const year = state.time.year;
  if (!choice && !force && ((state.events.cooldownUntil[id] ?? -1) > year || subjectOpen(state, `event:${id}`))) return null;
  // A yearly happening the player ruled on lately goes the same way, without asking again.
  if (!choice && def.recall) choice = recalledChoice(state, def);
  if (def.cooldown) state.events.cooldownUntil[id] = year + def.cooldown;
  setTag(state, `event:${id}`);
  const record = {id: `e${state.governance.nextCardId++}`, event: id, startedMonth: monthIndex(state.time),
    endsMonth: monthIndex(state.time) + 1, data: {}};
  state.events.active.push(record);
  for (const e of def.effects ?? []) applyEventOp(state, record, e);
  if (def.response) eventResponseRequested(state, record);
  if (def.participation) eventResponseRequested(state, record, 'festival_participation');
  if (def.vote) eventResponseRequested(state, record, 'strike_vote');
  if (id === 'strike') tellStory(state, 'labourers', 'strike');

  if (!def.choices) {
    addChronicle(state, def.line ?? def.title, 'line', {event: id});
    return record;
  }
  if (choice) {
    const option = def.choices.find((c) => c.key === choice) ?? def.choices[0];
    applyChoice(state, record, option, from);
    addChronicle(state, `${def.title}. The town chose to ${option.label.charAt(0).toLowerCase()}${option.label.slice(1)}.`, 'decision', {event: id});
    return record;
  }
  addCard(state, eventCard(state, def, record));
  return record;
}

function recalledChoice(state, def) {
  for (let i = state.cardHistory.length - 1; i >= 0; i--) {
    const h = state.cardHistory[i];
    if (state.time.year - h.year >= def.recall) break;
    if (h.templateId !== `event:${def.id}` || h.outcome !== 'accepted') continue;
    const c = def.choices.find((x) => x.key === h.choice);
    if (!c) return null;
    return Math.round((c.cost ?? 0) * costScale(state)) > (state.treasury ?? 0) ? def.lapse : c.key;
  }
  return null;
}

export function startEvent(state, id, opts = {}) {
  return fireEvent(state, id, opts);
}

function eventCard(state, def, record) {
  const scale = costScale(state);
  const vars = {years: state.time.year};
  // The status-quo choice goes last, where "no" usually sits.
  const ordered = [...def.choices.filter((c) => c.key !== def.lapse), ...def.choices.filter((c) => c.key === def.lapse)];
  const options = ordered.map((c) => {
    const cost = Math.round((c.cost ?? 0) * scale);
    return {key: c.key, label: c.label, tradeoff: fill(c.tradeoff, {cost: coin(cost)}), cost,
      effects: [{eventEffect: {event: def.id, record: record.id, choice: c.key}}]};
  });
  return makeCard(state, {
    kind: 'event', from: 'moot', templateId: `event:${def.id}`, category: 'event',
    subjects: [`event:${def.id}`, ...(def.subjects ?? [])],
    title: def.title, why: fill(def.why ?? '', vars), asker: {name: 'The town crier', role: 'news'},
    urgency: 2, cost: options[0].cost, data: {event: def.id, record: record.id, lapse: def.lapse ?? null, ...(record.data.bridgeId != null ? {bridgeId: record.data.bridgeId} : {})}, options,
  });
}

// Called by docket.applyEffects for an event card's chosen option.
export function applyEventEffect(state, card, spec) {
  const def = EVENTS[spec.event];
  const option = def?.choices?.find((c) => c.key === spec.choice);
  if (!option) return;
  addChronicle(state, `${def.title}. You chose to ${option.label.charAt(0).toLowerCase()}${option.label.slice(1)}.`, 'decision', {event: def.id, card: card.id});
  const record = state.events.active.find((a) => a.id === spec.record) ??
    {id: spec.record, event: spec.event, data: card.data?.bridgeId != null ? {bridgeId: card.data.bridgeId} : {}};
  applyChoice(state, record, option, card.id, card);
}

function applyChoice(state, record, option, from, card = null) {
  const cost = Math.round((option.cost ?? 0) * costScale(state));
  const generic = [];
  for (const e of option.effects ?? []) {
    if (isEventOp(e)) applyEventOp(state, record, e);
    else generic.push(e);
  }
  if (generic.length) {
    applyEffects(state, {id: from ?? record.id, templateId: `event:${record.event}`, cost, data: {}}, {key: option.key, effects: generic});
  }
}

const EVENT_OPS = ['pop', 'migrants', 'damage', 'crowd', 'mods', 'schedule', 'offer', 'patience', 'mood', 'cash',
  'inequality', 'close', 'split', 'banner', 'cancelCrowd', 'concede', 'fallen', 'rebuild'];
const isEventOp = (e) => EVENT_OPS.some((k) => e[k] !== undefined);

function applyEventOp(state, record, e) {
  if (!isEventOp(e)) {
    applyEffects(state, {id: record.id, templateId: `event:${record.event}`, cost: 0, data: {}}, {key: 'auto', effects: [e]});
    return;
  }
  const m = monthIndex(state.time);
  const mods = policyModifiers(state);
  if (e.pop !== undefined) {
    // Losses scale with rules like the infirmary; "spared" gives back part of a loss.
    const frac = e.pop * (e.mul ? mods.get(e.mul) : 1);
    if (frac < 0) record.data.lost = killShare(state, -frac);
    else if (frac > 0) immigrate(state, Math.max(1, Math.round(popOf(state) * frac * 0.5)));
  }
  if (e.migrants !== undefined) {
    const people = Math.max(1, Math.round(popOf(state) * e.migrants));
    const trade = {craftsman: 'craft', merchant: 'trade', 'poor-family': 'labour'}[e.kind] ?? null;
    immigrate(state, people, {trade, wealth: e.kind === 'merchant' ? 2 : e.kind === 'poor-family' ? 0.5 : 1});
  }
  if (e.damage) damage(state, record, e.damage, mods);
  if (e.crowd) crowd(state, record, e.crowd);
  if (e.cancelCrowd) state.worldEvents = state.worldEvents.filter((w) => w.source !== record.id);
  if (e.mods) {
    state.events.active.push({id: `${record.id}m`, event: record.event, startedMonth: m, endsMonth: m + (e.months ?? 1), mods: {...e.mods}});
  }
  if (e.schedule) {
    const [lo, hi] = e.schedule.years;
    state.events.scheduled ??= [];
    state.events.scheduled.push({event: e.schedule.event, month: m + 12 * rngInt(state, lo, hi)});
  }
  if (e.offer) offerTemplate(state, e.offer);
  if (e.patience) bodies.notePatience(state, e.patience.body, e.patience.amount);
  if (e.mood) {
    for (const f of state.factions) {
      if (f.trades?.some((t) => e.mood.trades.includes(t))) f.mood = clamp01(f.mood + e.mood.amount);
    }
  }
  if (e.cash) {
    for (const ent of state.enterprises) if (!ent.public && ent.cash > 0) pay(state, 'external', ent, Math.round(ent.cash * e.cash), 'boom');
  }
  if (e.inequality) state.governance.inequalityShock = (state.governance.inequalityShock ?? 0) + e.inequality;
  if (e.close) {
    const open = state.enterprises.filter((x) => !x.public).sort((a, b) => (a.cash ?? 0) - (b.cash ?? 0) || a.id - b.id);
    for (const ent of open.slice(0, Math.floor(open.length * e.close))) closeEnterprise(state, ent, 'bust');
  }
  if (e.split) state.governance.flags[`split:${e.split}`] = state.time.year;
  if (e.banner) bannerHomes(state, e.banner);
  if (e.concede) concedeGrievance(state);
  if (e.fallen) record.data.bridgeId = closeFallenBridge(state);
  if (e.rebuild) rebuildBridge(state, record.data.bridgeId, e.rebuild);
}

const popOf = (state) => state.indicators?.pop || state.households.reduce((n, h) => n + (h.size ?? 1), 0);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

function damage(state, record, spec, mods) {
  const at = placeFor(state, spec.at);
  const scale = spec.mul ? mods.get(spec.mul) : 1;
  if (spec.at === 'river') return floodDamage(state, record, at, spec, scale);
  if (spec.at === 'timber' && at.buildingIds) {
    const ids = new Set(at.buildingIds.slice(0, spec.count ? rngInt(state, spec.count[0], spec.count[1]) : undefined));
    for (const b of state.buildings) {
      if (!ids.has(b.id)) continue;
      b.condition = clamp01((b.condition ?? 1) + spec.condition * scale);
      touchBuilding(state, b);
    }
    record.data.damaged = ids.size;
    return;
  }
  const hit = state.buildings
    .filter((b) => b.type !== 'bridge' && Math.hypot(b.x - at.x, b.z - at.z) <= spec.radius)
    .sort((a, b) => Math.hypot(a.x - at.x, a.z - at.z) - Math.hypot(b.x - at.x, b.z - at.z) || a.id - b.id);
  const limit = spec.count ? rngInt(state, spec.count[0], spec.count[1]) : hit.length;
  for (const b of hit.slice(0, limit)) {
    b.condition = clamp01((b.condition ?? 1) + spec.condition * scale);
    touchBuilding(state, b);
  }
  record.data.damaged = Math.min(limit, hit.length);
}

// Floodwater reaches buildings near the bank; embankments spare most of them.
function floodDamage(state, record, at, spec, scale) {
  let n = 0;
  for (const b of state.buildings) {
    if (b.type === 'bridge' || Math.abs(b.z - at.z) > 80) continue;
    const risk = floodRisk(state, b);
    if (risk <= 0) continue;
    b.condition = clamp01((b.condition ?? 1) + spec.condition * scale * risk);
    touchBuilding(state, b);
    n++;
  }
  record.data.damaged = n;
}

// Something to see: a crowd, fire, floodwater or procession.
function crowd(state, record, spec) {
  const at = placeFor(state, spec.at);
  const t0 = monthIndex(state.time);
  const t1 = t0 + (spec.months ?? 1);
  state.worldEvents.push({
    id: `${record.id}:${spec.kind}`, kind: spec.kind, x: Math.round(at.x), z: Math.round(at.z),
    radius: spec.radius, strength: spec.strength ?? 0.6, ...(spec.faction ? {faction: spec.faction} : {}),
    t0, t1, source: record.id, event: record.event,
  });
  if (state.worldEvents.length > 40) state.worldEvents.splice(0, state.worldEvents.length - 40);
}

function bannerHomes(state, spec) {
  const m = monthIndex(state.time);
  const homes = state.buildings.filter((b) => b.type === spec.type);
  const n = Math.round(homes.length * spec.share);
  for (let i = 0; i < n && homes.length; i++) {
    const b = homes[Math.floor(rng(state) * homes.length)];
    b.banner = spec.value;
    b.bannerUntil = m + spec.months;
    touchBuilding(state, b);
  }
}

// A protest or riot crowd for a grievance, used by petitions and reactions.
export function spawnCrowd(state, kind, at, {strength = 0.6, months = 1, faction, radius = 10} = {}) {
  const record = {id: `w${state.governance.nextCardId++}`, event: kind, data: {}};
  crowd(state, record, {kind, at, radius, months, strength, faction});
  return record;
}

function offerTemplate(state, templateId) {
  const moot = bodies.bodyOf(state, 'moot');
  const owner = templateId === 'bridge' ? bodies.bodyOf(state, 'river-authority') ?? moot
    : templateId === 'pave-lane' ? bodies.bodyOf(state, 'planning') ?? moot : moot;
  const choices = bodies.eligibleTemplates(state, owner);
  const choice = choices.find((c) => c.id === templateId || c.policy === templateId);
  if (choice) addCard(state, bodies.draftCard(state, owner, choice));
}

// Riot "concede": give the angriest faction its top wish.
function concedeGrievance(state) {
  const angry = [...state.factions].sort((a, b) => a.mood - b.mood)[0];
  if (!angry) return;
  angry.mood = clamp01(angry.mood + 0.2);
  if (angry.trades?.includes('labour')) {
    const before = levelOf(state, 'wage-floor');
    applyEffects(state, {id: 'riot', templateId: 'event:riot', cost: 0, data: {}}, {key: 'concede', effects: [{policy: 'wage-floor', level: before + 1}]});
  }
}

// Temporary modifiers from active events, folded with rule modifiers.
export function eventModifiers(state) {
  const mul = {};
  for (const a of state.events?.active ?? []) {
    for (const [k, v] of Object.entries(a.mods ?? {})) mul[k] = (mul[k] ?? 1) * v;
  }
  return mul;
}

export function activeEventIds(state) {
  return [...new Set((state.events?.active ?? []).map((a) => a.event))].sort();
}

