// Seeds. A seed is a 32-bit number; players see and share it as a short code.
// Kept apart from the sim so the main menu can read and show seeds without
// loading the simulation.

export function newSeed() {
  const c = globalThis.crypto;
  if (c?.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0] || 1;
  return Math.floor(Math.random() * 4294967295) + 1;
}

// Share code: base 36, upper case ("HV3K9Q"). parseSeed reads a code back, a plain
// number, or hashes any other text, so "Riverbend" is a valley too.
export const seedCode = (seed) => (seed >>> 0).toString(36).toUpperCase();

export function parseSeed(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return (input >>> 0) || 1;
  const text = String(input).trim();
  if (/^[0-9]+$/.test(text)) return (Number(text) >>> 0) || 1;
  if (/^[0-9A-Za-z]{1,7}$/.test(text)) {
    const n = parseInt(text, 36);
    if (Number.isFinite(n) && n > 0 && n <= 0xffffffff) return n >>> 0;
  }
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) || 1;
}
