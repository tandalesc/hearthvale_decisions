// The woodland field, shared by the drawn forest (render/trees.js generateForest places
// its woods and copses from it) and the sim (people walk along the woods' edge, pick
// berries there in autumn). Pure: no Three.js, no state.
//
// woodField(x, z) is 0..1: broad wavy bands with smaller copse-sized lumps. The drawn
// woods are dense above WOOD_IN, thin out to nothing below WOOD_OUT (generateForest:
// density 0.4+ above 0.62, (w - 0.52) * 3 between), so the walkable edge of a wood is
// the band just outside it.

export const WOOD_IN = 0.62;
export const WOOD_OUT = 0.52;

/** 0..1 woodland field: broad wavy bands with smaller copse-sized lumps. */
export function woodField(x, z) {
  const a = Math.sin(x / 37 + Math.sin(z / 53) * 1.3) * 0.25;
  const b = Math.sin(z / 29 - x / 61 + 1.7) * 0.2;
  const c = Math.sin((x + z) / 17 + Math.cos(x / 23)) * 0.12;
  const d = Math.sin(x / 11 - z / 13) * 0.06;
  return 0.5 + a + b + c + d;
}

/** The field's gradient (toward denser woods), by central differences. */
export function woodGradient(x, z, h = 0.5) {
  return [(woodField(x + h, z) - woodField(x - h, z)) / (2 * h), (woodField(x, z + h) - woodField(x, z - h)) / (2 * h)];
}
