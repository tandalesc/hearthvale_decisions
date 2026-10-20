// Names for new towns, offered on the New town screen and used when a town is
// started without one.

const HEADS = ['Ash', 'Alder', 'Bram', 'Briar', 'Elder', 'Fern', 'Fox', 'Hazel', 'Holly', 'Kings', 'Lark', 'Long', 'Marsh', 'Mill', 'Oak', 'Rush', 'Stone', 'Thorn', 'Wil', 'Wren', 'Bright', 'Cold', 'Heath', 'Ox'];
const TAILS = ['ford', 'brook', 'wick', 'stead', 'ton', 'mere', 'ley', 'bury', 'combe', 'dale', 'holm', 'well', 'thorpe', 'field', 'bridge', 'hollow'];
const COAST_TAILS = ['mouth', 'hythe', 'haven', 'sands', 'port', 'wick'];

export function suggestName(landscape, avoid = '') {
  const tails = landscape === 'coast' || landscape === 'shore' || landscape === 'delta' ? COAST_TAILS : TAILS;
  for (let i = 0; i < 8; i++) {
    const name = HEADS[Math.floor(Math.random() * HEADS.length)] + tails[Math.floor(Math.random() * tails.length)];
    if (name !== avoid) return name;
  }
  return 'Hearthvale';
}
