// What each question kind does in the sim (design-systems §5.4).
//
// Per kind:
//   fallback(c, snap, state, offered) -> {option: weight}
//       The local distribution used when the service is offline or slow. It
//       reads the question's context and snapshot (and the town's traits), so
//       the offline town still snowballs and diverges.
//   deltas: {option: {pressureOrTrait: amount}}
//       Applied per sweep as expected share × amount × scale (§5.5).
//   perActor: true      one question per actor (shares are averaged over actors).
//   mask(state, subject) -> [options removed]; local(state, subject, probs) -> probs
//       Hard facts for one household or actor, applied after pooling.
//   apply(state, answers, sweep)
//       What governance-facing kinds do with their answers (cards, crowds, moods).
//
// Actor kinds (routine, stay/move, trade, enterprises, homes, sites, loans) are
// acted on by sim-core and sim-world, which read pooled distributions through
// the `distribution(state, kind, subject)` hook (scheduler.js).

import {weightsFor, levelOf, steadyPush} from '../policies.js';
import {delta} from '../pressures.js';
import {setTag} from '../state.js';
import {addChronicle} from '../chronicle.js';
import {factionById, moodBand, addFactionStory, factionOf, nudgeMood} from '../factions.js';
import {addStory} from '../households.js';
import * as bodies from '../institutions.js';
import * as docket from '../docket.js';
import * as events from '../events.js';
import {KIND_BY_ID} from './kinds.js';
import {subjectBlocked, timesAsked} from '../subjects.js';
import {walkout, resolveOf} from '../strikes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function normalise(weights, offered) {
  const out = {};
  let total = 0;
  for (const o of offered) {
    const w = Math.max(0, weights[o] ?? 0);
    out[o] = w;
    total += w;
  }
  if (total <= 0) {
    for (const o of offered) out[o] = 1 / offered.length;
    return out;
  }
  for (const o of offered) out[o] /= total;
  return out;
}

const mul = (w, key, factor) => {
  if (w[key] !== undefined) w[key] *= factor;
};

const T = (state, k) => state.traits?.[k] ?? 0;
const P = (state, k) => state.pressures?.[k] ?? 0;
const has = (list, id) => String(list ?? '').split(',').includes(id);

// Policy weight multipliers for a kind (Rule Book `weights`).
export function applyRuleWeights(state, kindId, probs) {
  const w = weightsFor(state, kindId);
  if (!Object.keys(w).length) return probs;
  const out = {...probs};
  for (const [o, f] of Object.entries(w)) if (out[o] !== undefined) out[o] *= f;
  return normalise(out, Object.keys(probs));
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export const EFFECTS = {
  resident_routine: {
    fallback(c, snap) {
      const base = {
        morning: {work: 0.55, rest: 0.08, shop: 0.15, leisure: 0.1, worship: 0.04, gather: 0.08},
        midday: {work: 0.5, rest: 0.05, shop: 0.2, leisure: 0.15, worship: 0.04, gather: 0.06},
        evening: {work: 0.1, rest: 0.45, shop: 0.1, leisure: 0.25, worship: 0.06, gather: 0.04},
      }[c.timeOfDay ?? 'morning'];
      const w = {...base};
      if (c.lifeStage === 'elder') { mul(w, 'work', 0.4); mul(w, 'rest', 1.5); mul(w, 'worship', 1.6); }
      if (c.lifeStage === 'young') mul(w, 'leisure', 1.4);
      if (c.energy === 'low') mul(w, 'rest', 3);
      if (c.fullness === 'low') mul(w, 'shop', 3);
      if (c.social === 'low') mul(w, 'leisure', 2);
      if (snap?.faith === 'high') mul(w, 'worship', 2);
      if (snap?.unrest === 'angry') mul(w, 'gather', 2);
      return w;
    },
    deltas: {worship: {faith: 0.0003}},
  },

  household_stay_move: {
    fallback(c, snap) {
      const w = {stay: 0.86, move_within: 0.06, emigrate: 0.04, bring_kin: 0.04, move_to_centre: c.otherTowns === 'some' ? 0.02 : 0};
      if (c.otherTowns === 'some' && snap?.homes === 'scarce') mul(w, 'move_to_centre', 2.5);
      if (c.otherTowns === 'some' && c.rentShare > 0.5) mul(w, 'move_to_centre', 2);
      if (c.wealthBand === 'poor') mul(w, 'emigrate', 1.5);
      if (c.wealthBand === 'wealthy') mul(w, 'bring_kin', 1.5);
      if (snap?.homes === 'scarce') { mul(w, 'move_within', 0.6); mul(w, 'bring_kin', 0.5); mul(w, 'emigrate', 1.3); }
      if (snap?.homes === 'plenty') mul(w, 'bring_kin', 1.6);
      if (snap?.unrest === 'angry') mul(w, 'emigrate', 2);
      if (snap?.wellbeing === 'good') { mul(w, 'emigrate', 0.6); mul(w, 'bring_kin', 1.4); }
      if (snap?.wellbeing === 'poor') mul(w, 'emigrate', 1.6);
      if (snap?.jobs === 'scarce') mul(w, 'emigrate', 1.4);
      if (snap?.jobs === 'plenty') mul(w, 'bring_kin', 1.4);
      if (c.newcomer === 'yes') { mul(w, 'move_within', 1.6); mul(w, 'emigrate', 1.3); }
      if (c.rentShare > 1) mul(w, 'emigrate', 2);
      if (c.vacancy === 'none') w.move_within = 0;
      return w;
    },
    local(state, h, probs) {
      const out = {...probs};
      if ((h.savings ?? 0) < (h.rent ?? 0)) out.emigrate *= Math.exp(1.5);
      return out;
    },
    deltas: {emigrate: {unrest: 0.004}, bring_kin: {prestige: 0.002}},
  },

  choose_trade: {
    fallback(c, snap, state) {
      const w = {farm: 0.14, craft: 0.14, trade: 0.12, labour: 0.2, clerical: 0.06, clergy: 0.04, leave_town: 0.05};
      const parent = c.trade === 'gentry' ? 'trade' : c.trade === 'none' ? 'labour' : c.trade;
      if (parent && w[parent] !== undefined) w[parent] += 0.45;
      const ind = T(state, 'industry'), mkt = T(state, 'market'), inn = T(state, 'innovation');
      w.craft *= 1 + Math.max(-0.8, ind);
      w.labour *= 1 + Math.max(-0.8, 1.2 * ind);
      w.farm *= 1 + Math.max(-0.8, -1.2 * ind);
      w.trade *= 1 + Math.max(-0.8, 1.5 * mkt) + 1.5 * P(state, 'riverTrade');
      w.clerical *= 1 + Math.max(-0.8, inn) + 2 * P(state, 'learning');
      w.clergy *= 1 + 2 * P(state, 'faith');
      if (snap?.jobs === 'scarce') w.leave_town *= 2;
      if (c.wealthBand === 'poor') { w.labour *= 1.3; w.clerical *= 0.6; }
      if (c.literacy === 'none') w.clerical *= 0.1;
      if (!has(snap?.bodies, 'parish')) w.clergy *= 0.3;
      return w;
    },
    deltas: {
      farm: {industry: -0.012}, craft: {industry: 0.01, innovation: 0.004}, trade: {market: 0.012, riverTrade: 0.004},
      labour: {industry: 0.01}, clerical: {learning: 0.01, innovation: 0.006}, clergy: {faith: 0.012}, leave_town: {unrest: 0.002},
    },
  },

  react_to_policy: {
    fallback(c, snap) {
      const side = sideOf(c.trade, snap);
      const w = side === 'helps' ? {support: 0.5, accept: 0.35, grumble: 0.1, protest: 0.03, strike: 0.01, leave: 0.01}
        : side === 'hurts' ? {support: 0.05, accept: 0.3, grumble: 0.35, protest: 0.15, strike: 0.08, leave: 0.07}
          : {support: 0.15, accept: 0.6, grumble: 0.2, protest: 0.04, strike: 0.005, leave: 0.005};
      if (c.wealthBand === 'poor' && snap?.category === 'tax') { mul(w, 'grumble', 1.5); mul(w, 'protest', 1.5); }
      if (snap?.unrest === 'angry') { mul(w, 'protest', 2); mul(w, 'strike', 1.5); }
      if (c.trade !== 'labour') w.strike = 0;
      return w;
    },
    deltas: {support: {unrest: -0.006}, grumble: {unrest: 0.004}, protest: {unrest: 0.015}, strike: {unrest: 0.02}, leave: {unrest: 0.006}},
    apply: applyReactions,
  },

  faction_stance: {
    fallback(c) {
      const w = c.side === 'helps' ? {for: 0.7, against: 0.08, split: 0.12, indifferent: 0.1}
        : c.side === 'hurts' ? {for: 0.08, against: 0.65, split: 0.15, indifferent: 0.12}
          : {for: 0.15, against: 0.15, split: 0.1, indifferent: 0.6};
      if (c.mood === 'angry') { mul(w, 'against', 1.6); mul(w, 'for', 0.7); }
      if (c.mood === 'glad') mul(w, 'for', 1.3);
      return w;
    },
    apply: applyStances,
  },

  institution_form_support: {
    fallback(c) {
      const own = BODY_FACTION[c.body] === c.faction;
      const w = own ? {back: 0.8, oppose: 0.05, indifferent: 0.15} : {back: 0.25, oppose: 0.2, indifferent: 0.55};
      if (RIVAL_FACTION[c.body]?.includes(c.faction)) { w.oppose = 0.55; w.back = 0.1; }
      return w;
    },
    apply: applyStances,
  },

  petition: {
    fallback(c) {
      const w = {
        angry: {wait: 0.25, petition_moot: 0.3, petition_body: 0.15, gather: 0.2, leave: 0.1},
        uneasy: {wait: 0.6, petition_moot: 0.2, petition_body: 0.12, gather: 0.05, leave: 0.03},
        content: {wait: 0.9, petition_moot: 0.05, petition_body: 0.04, gather: 0.005, leave: 0.005},
        glad: {wait: 0.97, petition_moot: 0.015, petition_body: 0.01, gather: 0.0025, leave: 0.0025},
      }[c.mood ?? 'content'];
      const out = {...w};
      if (c.hasBody !== 'yes') { out.petition_moot += out.petition_body; out.petition_body = 0; }
      if (c.grievance === 'none') { out.wait += out.petition_moot + out.gather; out.petition_moot = 0; out.gather = 0; }
      return out;
    },
    deltas: {gather: {unrest: 0.01}, leave: {unrest: 0.004}},
    apply: applyPetitions,
  },

  festival_participation: {
    fallback(c, snap) {
      const w = {join: 0.45, watch: 0.35, ignore: 0.15, protest: 0.05};
      if (c.event === 'feast' && c.faithBand === 'high') mul(w, 'join', 1.6);
      if (c.event === 'feast' && c.faithBand === 'low') mul(w, 'ignore', 1.8);
      if (c.event === 'fair' && c.faithBand === 'high') mul(w, 'protest', 1.5);
      if (snap?.unrest === 'angry') mul(w, 'protest', 3);
      if (snap?.wellbeing === 'good') mul(w, 'join', 1.3);
      return w;
    },
    deltas: {join: {prestige: 0.004, unrest: -0.004}, protest: {unrest: 0.008}},
    apply: applyFestival,
  },

  crime_charity: {
    fallback(c, snap) {
      const w = {honest: 0.85, petty_theft: 0.06, join_gang: 0.01, seek_alms: 0.05, give_alms: 0.03};
      if (c.wealthBand === 'poor') { mul(w, 'petty_theft', 2); mul(w, 'seek_alms', 2); w.give_alms = 0; }
      if (c.wealthBand === 'wealthy') { mul(w, 'give_alms', 4); mul(w, 'petty_theft', 0.2); mul(w, 'seek_alms', 0.1); }
      if (c.wealthBand === 'middling') w.give_alms *= 0.5;
      if (c.watch === 'yes') { mul(w, 'petty_theft', 0.6); mul(w, 'join_gang', 0.4); }
      if (c.alms === 'yes') mul(w, 'seek_alms', 1.5);
      if (snap?.unrest === 'angry') mul(w, 'join_gang', 3);
      if (snap?.jobs === 'scarce') mul(w, 'petty_theft', 1.6);
      return w;
    },
    deltas: {petty_theft: {unrest: 0.01}, join_gang: {unrest: 0.03}, give_alms: {unrest: -0.008, faith: 0.003}},
    apply: applyCrime,
  },

  event_response: {
    fallback(c, snap) {
      const w = {help: 0.4, flee: 0.1, hoard: 0.15, pray: 0.15, blame_council: 0.2};
      if (c.faithBand === 'high' || snap?.faith === 'high') mul(w, 'pray', 2);
      if (c.wealthBand === 'poor') { mul(w, 'blame_council', 1.4); mul(w, 'hoard', 0.7); }
      if (c.wealthBand === 'wealthy') { mul(w, 'hoard', 1.5); mul(w, 'flee', 1.3); }
      if (c.event === 'fire' || c.event === 'flood') mul(w, 'help', 1.3);
      if (c.event === 'plague') mul(w, 'flee', 2);
      if (c.event === 'riot' || c.event === 'bust') mul(w, 'blame_council', 1.5);
      if (snap?.unrest === 'angry') mul(w, 'blame_council', 1.5);
      return w;
    },
    deltas: {help: {unrest: -0.01}, pray: {faith: 0.015}, blame_council: {unrest: 0.02}},
    apply: applyEventResponse,
  },

  strike_resolve: {
    fallback(c, snap) {
      const w = {back_down: 0.2, some: 0.35, most: 0.3, solid: 0.15};
      if (c.wages === 'low') { mul(w, 'most', 1.4); mul(w, 'solid', 1.6); }
      if (c.wages === 'good') { mul(w, 'back_down', 2); mul(w, 'solid', 0.5); }
      if (c.hardship === 'much') { mul(w, 'most', 1.3); mul(w, 'solid', 1.5); }
      if (c.savings === 'thin') { mul(w, 'back_down', 1.6); mul(w, 'solid', 0.7); }
      if (c.savings === 'plenty') mul(w, 'solid', 1.4);
      if (c.mood === 'angry') { mul(w, 'solid', 1.8); mul(w, 'back_down', 0.6); }
      if (c.mood === 'glad') mul(w, 'back_down', 1.8);
      if (snap?.unrest === 'angry') mul(w, 'solid', 1.3);
      return w;
    },
    apply: applyStrikeResolve,
  },

  newcomer_integrate: {
    fallback(c, snap) {
      const w = {assimilate: 0.6, cluster: 0.3, move_on: 0.1};
      if (snap?.homes === 'scarce') mul(w, 'move_on', 2);
      if (snap?.unrest !== 'calm') mul(w, 'cluster', 1.3);
      return w;
    },
    deltas: {cluster: {}, move_on: {unrest: 0.002}},
    apply: applyIntegration,
  },

  enterprise_plan: {
    perActor: true,
    fallback(c, snap, state) {
      const w = {hold: 0.55, expand: 0.2, automate: 0.05, diversify: 0.08, close: 0.05, relocate: 0.02, sell_site: 0.01, downsize: 0.03};
      // Rent and a buyer's offer push the land-hungry out of dear sites.
      const hungry = c.landHungry === 'yes' ? 2 : 1;
      if (c.rent === 'moderate') { mul(w, 'relocate', 1.5 * hungry); mul(w, 'downsize', 1.3); }
      if (c.rent === 'heavy') { mul(w, 'relocate', 4 * hungry); mul(w, 'sell_site', 2 * hungry); mul(w, 'downsize', 2); mul(w, 'expand', 0.5); }
      if (c.rent === 'crushing') { mul(w, 'relocate', 8 * hungry); mul(w, 'sell_site', 4 * hungry); mul(w, 'downsize', 3); mul(w, 'expand', 0.15); mul(w, 'hold', 0.6); }
      if (c.siteOffer === 'fair') mul(w, 'sell_site', 2 * hungry);
      if (c.siteOffer === 'rich') { mul(w, 'sell_site', 6 * hungry); mul(w, 'relocate', 1.5); mul(w, 'hold', 0.8); }
      if (c.siteOffer === 'huge') { mul(w, 'sell_site', 10 * hungry); mul(w, 'relocate', 2); mul(w, 'hold', 0.6); }
      if (c.cheaperSite === 'none') { w.relocate *= 0.2; }
      if (c.cheaperSite === 'far') w.relocate *= 0.6;
      if (c.profit > 0 && c.cash > c.jobs * 20) mul(w, 'expand', 2);
      if (c.profit < 0) { mul(w, 'close', 3); mul(w, 'diversify', 2); mul(w, 'expand', 0.3); }
      if (c.cash < 0) mul(w, 'close', 2);
      if (c.demand === 'high') mul(w, 'expand', 1.5);
      if (c.demand === 'low') mul(w, 'diversify', 1.5);
      if (c.labour === 'short') mul(w, 'automate', 3);
      w.automate *= 1 + Math.max(0, T(state, 'industry')) + Math.max(0, T(state, 'innovation'));
      if ((state.era ?? 0) < 3) w.automate = 0;
      return w;
    },
    deltas: {expand: {market: 0.002}, automate: {industry: 0.003, innovation: 0.002}, close: {unrest: 0.001}},
  },

  enterprise_found: {
    perActor: true,
    fallback(c, snap, state) {
      const ind = T(state, 'industry'), mkt = T(state, 'market');
      const short = String(c.shortGoods ?? '');
      const w = {
        none: 0.35, farm: 0.08 * (1 - ind), workshop: 0.08 * (1 + ind), shop: 0.08 * (1 + mkt), inn: 0.04 + P(state, 'prestige') * 0.1,
        mill: 0.04 * (1 + 2 * Math.max(0, ind)), warehouse: 0.02 + P(state, 'riverTrade') * 0.15,
        school: 0.02 + P(state, 'learning') * 0.1, chapel_donation: 0.02 + P(state, 'faith') * 0.1,
      };
      if (short.includes('food')) w.farm *= 2;
      if (short.includes('goods')) { w.workshop *= 2; w.mill *= 1.5; }
      if (c.riverTrade === 'high') w.warehouse *= 2;
      if (!levelOf(state, 'mill-rights') && (state.era ?? 0) < 2) w.mill *= 0.3;
      return w;
    },
    deltas: {
      farm: {industry: -0.004}, workshop: {industry: 0.003}, shop: {market: 0.003}, inn: {prestige: 0.002},
      mill: {industry: 0.006, ecology: -0.002}, warehouse: {riverTrade: 0.004}, school: {learning: 0.004}, chapel_donation: {faith: 0.004},
    },
  },

  enterprise_type_for_site: {
    perActor: true,
    fallback(c, snap, state) {
      const w = EFFECTS.enterprise_found.fallback({...c, riverTrade: snap?.river === 'thronged' ? 'high' : 'mid'}, snap, state);
      delete w.none;
      delete w.school;
      delete w.chapel_donation;
      if (w[c.current] !== undefined) w[c.current] *= 0.2;
      return w;
    },
  },

  choose_site: {
    perActor: true,
    fallback(c) {
      return {a: 0.45, b: c.b ? 0.25 : 0, c: c.c ? 0.15 : 0, d: c.d ? 0.1 : 0, wait: 0.05};
    },
  },

  migration_wave: {
    fallback(c, snap) {
      const w = {none: 0.45, trickle: 0.4, wave: 0.1, exodus_pull: 0.05};
      if (c.prestige === 'high') mul(w, 'wave', 2.5);
      if (c.prestige === 'low') mul(w, 'wave', 0.6);
      if (/plague|riot|bust/.test(c.recent ?? '')) mul(w, 'exodus_pull', 3);
      if (c.neighbours === 'troubled') mul(w, 'wave', 2);
      if (snap?.wellbeing === 'poor') { mul(w, 'exodus_pull', 2); mul(w, 'wave', 0.5); }
      if (snap?.homes === 'scarce') mul(w, 'wave', 0.6);
      if (snap?.jobs === 'plenty') mul(w, 'wave', 1.5);
      return w;
    },
    apply: applyMigration,
  },

  merchant_speculate: {
    fallback(c, snap, state) {
      const w = {invest_build: 0.25, invest_trade: 0.3, hoard: 0.35, lend_to_town: 0.1};
      if (c.mood === 'glad') { mul(w, 'invest_build', 1.5); mul(w, 'invest_trade', 1.5); }
      if (c.mood === 'angry') mul(w, 'hoard', 2);
      if (snap?.river === 'thronged') mul(w, 'invest_trade', 1.5);
      const m = 1 + Math.max(-0.5, T(state, 'market'));
      w.invest_build *= m;
      w.invest_trade *= m;
      return w;
    },
    deltas: {invest_build: {market: 0.004}, invest_trade: {riverTrade: 0.004, market: 0.002}},
  },

  institution_draft: {
    fallback(c) {
      const w = {none: 0.12};
      for (let i = 1; i <= 6; i++) if (c[`p${i}`]) w[`p${i}`] = (1 + (c[`n${i}`] ?? 1)) ** 2;
      return w;
    },
    apply: applyDraft,
  },

  institution_negotiate: {
    fallback(c) {
      const w = {accept_half: 0.5, insist: 0.3, withdraw: 0.2};
      if (c.power >= 0.75) mul(w, 'insist', 2);
      if (c.patience <= 0.3) mul(w, 'withdraw', 2);
      return w;
    },
    apply(state, answers) {
      for (const a of answers) docket.applyNegotiation(state, a.subject.cardId, a.choice);
    },
  },

  household_home: {
    perActor: true,
    fallback(c) {
      const w = {keep: 0.6, repair: 0.2, extend: 0.1, rebuild_up: 0.08, buy_second: 0.02};
      if (c.savings !== undefined) {
        if (c.savings >= (c.nextCost ?? Infinity)) mul(w, 'rebuild_up', 4);
        else if (c.savings >= 0.6 * (c.nextCost ?? Infinity)) { mul(w, 'rebuild_up', 2); mul(w, 'extend', 2); }
        else { mul(w, 'rebuild_up', 0.2); mul(w, 'extend', 0.5); }
        if ((c.condition ?? 1) < 0.5) mul(w, 'repair', 3);
        if (c.homeTier >= (c.eraMaxTier ?? 5)) w.rebuild_up = 0;
        if (c.canExtend === 'no') w.extend = 0;
        if ((c.neighboursTier ?? 1) > (c.homeTier ?? 1)) mul(w, 'rebuild_up', 1.5);
      }
      if (c.wealthBand === 'poor') { w.rebuild_up *= 0.3; w.buy_second = 0; }
      if (c.wealthBand === 'wealthy') mul(w, 'buy_second', 2);
      if (c.trade && c.trade !== 'gentry' && c.wealthBand !== 'wealthy') w.buy_second = 0;
      return w;
    },
    deltas: {rebuild_up: {innovation: 0.0005}, buy_second: {}},
  },

  farm_land: {
    perActor: true,
    fallback(c) {
      // Selling rises with what the land fetches against what it earns.
      const r = {low: 0.5, mid: 1.5, high: 3, very_high: 6}[c.valueRatio] ?? 1;
      const w = {keep: 2, sell_some_plots: Math.min(4, r / 2), sell_all_and_move_out: Math.min(3, (r / 4) ** 2)};
      if (c.profit === 'loss') { mul(w, 'sell_some_plots', 1.5); mul(w, 'sell_all_and_move_out', 2); }
      if (c.profit === 'good') mul(w, 'keep', 1.5);
      if (c.ownerAge === 'elder') mul(w, 'sell_all_and_move_out', 1.5);
      if (c.yearsFarmed > 40) mul(w, 'keep', 1.3);
      if (c.agriCouncil === 'yes') mul(w, 'keep', 1.2);
      return w;
    },
    deltas: {sell_some_plots: {market: 0.001}, sell_all_and_move_out: {market: 0.002, industry: 0.001}},
  },

  take_loan: {
    perActor: true,
    fallback(c) {
      const w = {hold: 0.5, borrow_small: 0.3, borrow_large: 0.1, sell_up: 0.1};
      if (c.cash < 0) mul(w, 'sell_up', 2);
      if (c.rate === 'high') { mul(w, 'borrow_small', 0.5); mul(w, 'borrow_large', 0.4); }
      if (c.debt > c.monthlyCost * 24) mul(w, 'borrow_large', 0.2);
      if ((c.losing ?? 0) >= 2) mul(w, 'sell_up', 2);
      return w;
    },
  },
};

const BODY_FACTION = {
  'agri-council': 'farmers', 'trades-guild': 'crafters', exchange: 'merchants', 'river-authority': 'labourers',
  'school-board': 'scholars', parish: 'clergy', union: 'labourers', 'arts-society': 'merchants', planning: 'scholars',
  'health-board': 'scholars', watch: 'gentry', moot: 'gentry',
};
const RIVAL_FACTION = {
  union: ['gentry', 'merchants'], exchange: ['crafters', 'labourers'], 'trades-guild': ['merchants'],
  parish: ['scholars'], 'school-board': ['clergy'], planning: ['farmers'], watch: ['labourers'],
};

function sideOf(trade, snap) {
  if (!trade || !snap) return 'neutral';
  if (has(snap.hurts, trade)) return 'hurts';
  if (has(snap.helps, trade)) return 'helps';
  return 'neutral';
}

export function fallbackFor(kindId, context, snap, state, offered) {
  const fx = EFFECTS[kindId];
  const kind = KIND_BY_ID[kindId];
  const opts = offered ?? Object.keys(kind.criteria);
  const raw = fx?.fallback ? fx.fallback(context ?? {}, snap ?? null, state, opts) : {};
  return applyRuleWeights(state, kindId, normalise(raw, opts));
}

// ---------------------------------------------------------------------------
// Appliers for governance-facing kinds. `answers` = [{key, subject, probs, choice, context}]
// sorted by key; `sweep` holds the kind and the snapshot.
// ---------------------------------------------------------------------------

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Faction moods follow how their trades reacted; a large protest fills the square.
function applyReactions(state, answers, sweep) {
  const byTrade = {};
  let protestCrowd = null;
  for (const a of answers) {
    const trade = a.subject.dim === 'trade' ? a.subject.value : null;
    const share = (a.probs.protest ?? 0) + (a.probs.strike ?? 0);
    if (trade) byTrade[trade] = a.probs;
    if (share >= 0.25 && (!protestCrowd || share > protestCrowd.share)) protestCrowd = {share, a};
  }
  for (const f of state.factions) {
    const rows = (f.trades ?? []).map((t) => byTrade[t]).filter(Boolean);
    if (!rows.length) continue;
    const mood = rows.reduce((n, p) => n + (p.support ?? 0) * 0.2 - (p.grumble ?? 0) * 0.08 - ((p.protest ?? 0) + (p.strike ?? 0) + (p.leave ?? 0)) * 0.2, 0) / rows.length;
    nudgeMood(f, clamp01(f.mood + mood), 'reactions');
  }
  if (protestCrowd) {
    const faction = protestCrowd.a.subject.dim === 'trade' ? tradeFaction(protestCrowd.a.subject.value) : undefined;
    events.spawnCrowd(state, 'protest', 'square', {strength: Math.min(1, protestCrowd.share * 2), months: 1, faction, radius: 12});
    setTag(state, 'protest');
    if (faction) tellStory(state, faction, 'protest', sweep?.meta?.rule ? `against ${sweep.meta.rule.toLowerCase()}` : null);
    if (sweep?.meta?.rule) addChronicle(state, `People took to the square over ${sweep.meta.rule.toLowerCase()}.`, 'line', {policy: sweep.meta.policy});
  }
  // Workers who would strike over a rule, where a union exists, may walk out.
  const labour = byTrade.labour;
  if (labour && (labour.strike ?? 0) >= 0.3 && bodies.bodyOf(state, 'union')?.status === 'active') {
    events.fireEvent(state, 'strike');
  }
  // Leaving pushes households toward emigration for a year.
  state.governance.leaveBias ??= {};
  for (const [trade, p] of Object.entries(byTrade)) {
    if ((p.leave ?? 0) > 0.05) state.governance.leaveBias[trade] = {amount: p.leave, until: state.time.year + 1};
  }
}

// A faction's story, and the same line on a few of its households.
export function tellStory(state, factionId, kind, text = null) {
  addFactionStory(state, factionId, kind, text);
  const f = factionById(state, factionId);
  if (!f) return;
  let n = 0;
  for (const h of state.households) {
    if (n >= 12) break;
    if (factionOf(state, h) !== factionId) continue;
    addStory(state, h, kind, text ? {text} : {});
    n++;
  }
}

const tradeFaction = (trade) => ({farm: 'farmers', craft: 'crafters', trade: 'merchants', labour: 'labourers', none: 'labourers',
  clergy: 'clergy', clerical: 'scholars', gentry: 'gentry'}[trade]);

function applyStances(state, answers) {
  for (const a of answers) {
    const card = state.docket.find((c) => c.id === a.subject.cardId);
    if (!card) continue;
    // The stance shown is the faction's most likely answer, so it always matches its probabilities.
    const top = Object.keys(a.probs).sort().reduce((best, k) => (a.probs[k] > (a.probs[best] ?? -1) ? k : best));
    card.stances[a.subject.faction] = {stance: top, p: Math.round((a.probs[top] ?? 0) * 100) / 100, probs: roundProbs(a.probs)};
    const f = factionById(state, a.subject.faction);
    if (f) f.stances[card.id] = top;
  }
}

const roundProbs = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Math.round(v * 100) / 100]));

const GRIEVANCE_BODY = {
  food: 'agri-council', housing: 'planning', wages: 'union', roads: 'planning', flood: 'river-authority',
  health: 'health-board', faith: 'parish', schooling: 'school-board', tolls: 'exchange', crime: 'watch', eyesores: 'planning',
};
const GRIEVANCE_TEXT = {
  food: 'there is not enough food', housing: 'there are not enough homes', wages: 'wages are too low',
  roads: 'the lanes are mud', flood: 'the river floods their homes', health: 'too many people are sick',
  faith: 'the town has lost its faith', schooling: 'their children cannot read', tolls: 'the tolls are too high',
  crime: 'the streets are not safe', eyesores: 'their streets are shabby, with empty houses and litter',
};
const GRIEVANCE_CATEGORY = {food: 'food', housing: 'land', wages: 'labour', roads: 'infrastructure', flood: 'environment',
  health: 'health', faith: 'faith', schooling: 'education', tolls: 'trade', crime: 'civic', eyesores: 'land'};

function applyPetitions(state, answers) {
  for (const a of answers) {
    const faction = factionById(state, a.subject.value ?? a.subject.faction);
    if (!faction || (faction.size <= 0 && !a.subject.torn)) continue;
    const grievance = a.context.grievance;
    const pressing = (a.probs.petition_moot ?? 0) + (a.probs.petition_body ?? 0);
    if ((a.probs.gather ?? 0) >= 0.15) {
      events.spawnCrowd(state, 'protest', 'square', {strength: Math.min(1, a.probs.gather * 3), faction: faction.id, radius: 10});
      tellStory(state, faction.id, 'petition', `about ${grievance}`);
    }
    if (pressing < 0.3 || grievance === 'none') continue;
    if (state.docket.some((c) => c.kind === 'petition' &&
      (c.data?.faction === faction.id || c.data?.petitioners?.some((p) => p.faction === faction.id)))) continue;
    // A group that was heard on this grievance waits eight years (sent away,
    // four), unless its mood has fallen hard since.
    if (subjectBlocked(state, [`petition:${faction.id}:${grievance}`], {mood: faction.mood})) continue;
    docket.addCard(state, grievanceCard(state, faction, grievance, a.subject.torn ? tornName(state, a.context, faction) : null));
    tellStory(state, faction.id, 'petition', `about ${grievance}`);
  }
}

// "Poor farmers in Mill Lane": the torn group, in plain words.
function tornName(state, c, faction) {
  const who = `${c.wealthBand ? `${c.wealthBand === 'middling' ? 'Middling' : c.wealthBand === 'poor' ? 'Poor' : 'Wealthy'} ` : ''}${faction.name.toLowerCase()}`;
  return `${who}${c.district ? ` in ${c.district}` : ''}`;
}

function grievanceCard(state, faction, grievance, groupName = null) {
  const body = bodies.bodyOf(state, GRIEVANCE_BODY[grievance]);
  const owner = body?.status === 'active' ? body : bodies.bodyOf(state, 'moot');
  const who = groupName ?? `The ${faction.name.toLowerCase()}`;
  const category = GRIEVANCE_CATEGORY[grievance] ?? 'civic';
  // A group that comes back asks harder: new words, and a firmer push on the body.
  const again = timesAsked(state, `petition:${faction.id}:${grievance}`) > 0;
  const mood = moodBand(faction.mood);
  const concern = `${again ? 'They' : who} are generally ${mood}${mood === 'content' || mood === 'glad' ? ', but' : ' and'} ${again ? 'still ' : ''}say ${GRIEVANCE_TEXT[grievance]}.`;
  const fix = (t) => t.replace(/^the /, 'The ');
  return docket.makeCard(state, {
    kind: 'petition', from: 'moot', templateId: `grievance:${grievance}`, category,
    title: fix(again ? `${who} petition the council again` : `${who} petition the council`),
    why: fix(again
      ? `${who} have come before. ${concern} This time they want a plan, not a promise.`
      : `${concern} They want to be heard.`),
    asker: {name: `A ${faction.name.toLowerCase().replace(/s$/, '')}`, role: 'petitioner'}, urgency: again ? 2 : 1, cost: 0,
    helps: faction.trades, hurts: [],
    data: {faction: faction.id, grievance, mood: Math.round(faction.mood * 100) / 100, again,
      groupName: who, grievanceText: GRIEVANCE_TEXT[grievance]},
    subjects: [`petition:${faction.id}:${grievance}`],
    options: [
      again
        ? {key: 'hear', label: 'Order a plan at once', tradeoff: `The ${owner.name} must bring a plan this year.`,
          effects: [{deltas: {unrest: -0.03}}, {focus: {body: owner.id, category, boost: 0.6}}]}
        : {key: 'hear', label: 'Hear them and promise action', tradeoff: `The ${owner.name} will bring a plan soon.`,
          effects: [{deltas: {unrest: -0.02}}, {focus: {body: owner.id, category}}]},
      {key: 'not_now', label: 'Not now', tradeoff: again ? 'They go home angry. They will remember this.' : 'They go home unhappy.', effects: []},
    ],
  });
}

function applyFestival(state, answers, sweep) {
  let join = 0, n = 0, protest = 0;
  for (const a of answers) {
    join += a.probs.join ?? 0;
    protest += a.probs.protest ?? 0;
    n++;
  }
  if (!n) return;
  const record = sweep?.meta?.record;
  const crowd = state.worldEvents.find((w) => w.source === record);
  if (crowd) crowd.strength = Math.round(Math.min(1, 0.3 + join / n) * 100) / 100;
  if (protest / n > 0.2) events.spawnCrowd(state, 'protest', 'square', {strength: protest / n, radius: 8});
}

function applyCrime(state, answers) {
  let crime = 0, n = 0;
  for (const a of answers) {
    crime += (a.probs.petty_theft ?? 0) + 3 * (a.probs.join_gang ?? 0);
    n++;
  }
  state.governance.crime = n ? Math.round((crime / n) * 1000) / 1000 : 0;
}

function applyEventResponse(state, answers, sweep) {
  let blame = 0, hoard = 0, help = 0, n = 0;
  for (const a of answers) {
    blame += a.probs.blame_council ?? 0;
    hoard += a.probs.hoard ?? 0;
    help += a.probs.help ?? 0;
    n++;
  }
  if (!n) return;
  if (hoard / n > 0.15) docket.applyEffects(state, {id: 'hoard', templateId: 'hoarding', cost: 0, data: {}}, {key: 'auto', effects: [{food: -0.02 * (hoard / n) * 5}]});
  const crowd = state.worldEvents.find((w) => w.source === sweep?.meta?.record);
  if (crowd) crowd.strength = Math.round(Math.min(1, crowd.strength * (0.7 + help / n)) * 100) / 100;
}

// The workers' resolve scales each household's own draw (strikes.js).
function applyStrikeResolve(state, answers, sweep) {
  if (sweep?.meta?.record == null) return;
  walkout(state, sweep.meta.record, resolveOf(answers[0]?.probs));
}

function applyIntegration(state, answers) {
  let cluster = 0, n = 0;
  for (const a of answers) {
    cluster += a.probs.cluster ?? 0;
    n++;
  }
  if (n && cluster / n > 0.45) {
    state.governance.newQuarter = state.time.year;
    setTag(state, 'newcomer-quarter');
  }
}

function applyMigration(state, answers) {
  const a = answers[0];
  if (!a) return;
  state.governance.lastMigration = {choice: a.choice, year: state.time.year};
  if (a.choice === 'wave') events.fireEvent(state, 'migration-wave');
  else if (a.choice === 'exodus_pull') events.fireEvent(state, 'exodus');
  else if (a.choice === 'trickle') state.governance.migrantRequests = (state.governance.migrantRequests ?? 0) + Math.max(1, Math.round((state.indicators?.pop ?? 30) * 0.01 / 4));
}

function applyDraft(state, answers) {
  for (const a of answers) {
    const body = bodies.bodyOf(state, a.subject.bodyId);
    if (!body || body.status !== 'active') continue;
    bodies.markDrafted(state, body);
    if (a.choice === 'none') continue;
    const options = a.subject.options;
    const index = Number(a.choice.slice(1)) - 1;
    const choice = options[index];
    if (!choice) continue;
    let card = bodies.draftCard(state, body, choice);
    // Batching: a close second becomes "Which first?".
    const second = options.find((o, i) => i !== index && o.need >= choice.need * 0.85 && o.need > 0.45);
    if (second && card.kind === 'proposal' && !card.data?.ease) {
      const other = bodies.draftCard(state, body, second);
      if (other.kind === 'proposal') card = docket.batchCards(state, card, other);
    }
    docket.addCard(state, card);
  }
}

// ---------------------------------------------------------------------------
// Sweep deltas: expected share of each option × its deltas × scale
// ---------------------------------------------------------------------------

// Actors' pushes per sweep, on the same footing as DELTA_SCALE in policies.js.
export const ACTOR_SCALE = 0.3;

export function applySweepDeltas(state, kindId, shares) {
  const fx = EFFECTS[kindId];
  if (!fx?.deltas) return;
  const pop = state.indicators?.pop || state.households.reduce((n, h) => n + (h.size ?? 1), 0);
  // Shares are averages over the actors (or people) asked, so a town of many
  // small businesses pushes no harder than one of a few big ones.
  const scale = Math.max(0.05, Math.min(3, pop / 1000)) * ACTOR_SCALE;
  for (const [option, share] of Object.entries(shares)) {
    for (const [key, amount] of Object.entries(fx.deltas[option] ?? {})) {
      if (amount && share) delta(state, key, steadyPush(state, key, amount * share * scale), `actors:${kindId}`);
    }
  }
}

