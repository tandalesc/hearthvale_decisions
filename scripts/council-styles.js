// Stand-in council play styles for headless runs (scripts/balance.js,
// scripts/distill-collect.js): how often a council accepts cards and bodies,
// how much it spends, and what it favours.
export const STYLES = {
  frugal: {accept: 0.15, acceptBodies: 0.6, spendShare: 0.15},
  balanced: {accept: 0.35, acceptBodies: 0.85, spendShare: 0.3},
  generous: {accept: 0.7, acceptBodies: 0.95, spendShare: 1, reckless: true},
  // Councils with a taste: they back options that push their traits and pressures.
  agrarian: taste({industry: -1, market: -0.3, ecology: 0.5}, ['agri-council'], ['farm']),
  industrial: taste({industry: 1, innovation: 0.5, ecology: -0.2}, ['trades-guild', 'union'], ['mill', 'factory', 'workshop']),
  mercantile: taste({market: 1, riverTrade: 1}, ['exchange', 'river-authority'], ['market', 'warehouse', 'quay', 'exchange', 'shop']),
  pious: taste({faith: 1, prestige: 0.5}, ['parish', 'arts-society'], ['chapel', 'monument']),
  scholarly: taste({learning: 1, innovation: 0.6}, ['school-board'], ['school', 'library']),
  green: taste({ecology: 1, health: 0.6, industry: -0.5}, ['health-board', 'planning'], ['park', 'infirmary']),
  communal: taste({market: -1, authority: -0.8, unrest: -0.3}, ['agri-council', 'union'], ['moot']),
};

function taste(prefers, bodies, builds) {
  return {accept: 0.3, acceptBodies: 0.6, spendShare: 0.35, prefers, bodies, builds};
}
