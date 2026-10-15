// Ground rent and bid-rent sorting. Every private enterprise pays rent for the land it
// stands on, monthly: land value × footprint cells × GROUND_RATE × price level. It goes
// to the building's owner when that is another household (a landlord), else to the
// treasury as a site tax. Land-hungry, thin-margin work (farms, workshops, mills) feels
// it first in the core; shops and inns there can carry it. Enterprises that cannot may
// relocate to cheaper land, sell the site, or downsize (enterprises.js).
//
// Land value comes from sim-world (sites.landValueAt) and is cached on the enterprise
// once a year (ent.landValue), so the monthly loop stays cheap.

import {byId} from './state.js';
import {priceLevel} from './pressures.js';
import {landValueAt, worldToCell} from './sites.js';

export const GROUND_RATE = 0.04;      // coin per land-value point per cell per month (× price level)
const SITE_YEARS = 40;                // a developer pays this many years of ground rent for a site

export const footprintCells = (b) => Math.max(1, ((b.w ?? 4) * (b.d ?? 4)) / 4);

export function landValueOf(state, b) {
  const [cx, cz] = worldToCell(b.x, b.z);
  return Math.max(0, landValueAt(state, cx, cz));
}

// Yearly: refresh each enterprise's land value, and the district values used to find
// cheaper ground.
export function refreshLand(state) {
  for (const ent of state.enterprises) {
    const b = byId(state, 'buildings', ent.buildingId);
    if (b) ent.landValue = landValueOf(state, b);
  }
  state.districtLand = {};
  for (const d of state.districts) {
    const [cx, cz] = worldToCell(d.centroid.x, d.centroid.z);
    state.districtLand[d.id] = Math.max(0, landValueAt(state, cx, cz));
  }
}

// A rent cap rule (sim-governance: modifierAdds.rentCap, 0.9 or 0.8) holds rents down.
export function monthlyRent(state, ent) {
  const b = byId(state, 'buildings', ent.buildingId);
  if (!b || ent.public) return 0;
  const cap = state.modifierAdds?.rentCap || 1;
  return GROUND_RATE * (ent.landValue ?? 20) * footprintCells(b) * priceLevel(state) * cap;
}

// What a developer would pay for the site, and what the business is worth to its owner.
export function siteValue(state, ent) {
  return monthlyRent(state, ent) * 12 * SITE_YEARS;
}

export function businessValue(state, ent) {
  return Math.max(0, ent.profitLastYear ?? 0) * 8 + Math.max(0, ent.cash);
}

// The cheapest district whose land is well below this enterprise's (and how much).
export function cheaperGround(state, ent) {
  const here = ent.landValue ?? 0;
  let best = null;
  for (const d of state.districts) {
    const v = state.districtLand?.[d.id];
    if (v == null || v > 0.6 * here) continue;
    if (!best || v < best.value) best = {district: d, value: v};
  }
  if (!best) return null;
  const b = byId(state, 'buildings', ent.buildingId);
  const distance = b ? Math.hypot(best.district.centroid.x - b.x, best.district.centroid.z - b.z) : 0;
  return {...best, ratio: here > 0 ? best.value / here : 1, distance};
}

// Context for the decision layer (kind enterprise_plan), refreshed yearly:
//   ent.rentShare   rent / revenue last year (a number)
//   ent.siteRatio   what a developer would pay / what the business is worth
//   ent.siteOffer   that as a band: 0 none (< 1), 1 fair (1-3), 2 rich (>= 3)
//   ent.cheaper     {districtId, ratio, distance} | null, and ent.cheaperSite 'near' | 'far' | 'none'
export function landContext(state, ent) {
  const revenue = Math.max(1, ent.revenueLastYear ?? 0);
  ent.rentShare = Math.round((100 * (ent.rentLastYear ?? 0)) / revenue) / 100;
  ent.siteRatio = Math.round((100 * siteValue(state, ent)) / Math.max(1, businessValue(state, ent))) / 100;
  ent.siteOffer = ent.siteRatio < 1 ? 0 : ent.siteRatio < 3 ? 1 : 2;
  const c = cheaperGround(state, ent);
  ent.cheaper = c ? {districtId: c.district.id, ratio: Math.round(c.ratio * 100) / 100, distance: Math.round(c.distance)} : null;
  ent.cheaperSite = !c ? 'none' : c.distance < 80 ? 'near' : 'far';
  return ent;
}
