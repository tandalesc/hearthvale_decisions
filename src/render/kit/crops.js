// What grows on a farm's field, season by season (kit 'field' piece, the
// CROP_PIECE material variant). Everything is worked out in the vertex shader
// from the farm's kind, era and seed, the year and the time of year, so fields
// turn over without any CPU work or rebuild.
//
// The year opens in spring (yearT 0; summer 0.25, autumn 0.5, winter 0.75).
//
// Kinds (compose.js passes the farm variant as the field's iStyle.z):
//   0 arable   a rotation, a crop a year:
//              hamlet and village (era < 2): open fields in strips of three
//              rows, each strip on its own course of the three-field round
//              (wheat, barley, fallow);
//              from the town era: one crop a field, the four-course round
//              (wheat, roots, barley, clover), with flax for clover in some
//              years and, from the city era, rapeseed for barley.
//   1 market garden   a vegetable a row (cabbages, leeks, carrots, beans,
//              potatoes), sown in turn; cabbages and leeks stand the winter.
//   2 orchard  a mown sward under the fruit trees (trees.js plants those).
//   3 dairy    grazed pasture, buttercups in late spring.
//
// Crops (cropOf): 0 wheat, 1 barley, 2 roots, 3 clover (fallow before the
// town era), 4 flax, 5 rapeseed, 6 vegetables, 7 orchard sward, 8 pasture.
//
// The field piece (geometry.js fieldPiece) is a soil bed and nine ridged rows;
// a crop sets each row's height and width and both colours. At harvest the
// rows are cut to stubble with a few stooks (or haycocks) standing about
// (before the Industrial era), then ploughed to bare furrows before the next sowing.

export const FIELD_ROWS = 9;
export const FIELD_SEG = 16;

/** Farm variant -> field kind (iStyle.z of the field piece). */
export function fieldKind(variant) {
  return variant === 'market-garden' ? 1 : variant === 'orchard' ? 2 : variant === 'dairy' ? 3 : 0;
}

export const CROP_GLSL = /* glsl */ `
#ifdef CROP_PIECE
uniform float uYear;
struct Crop {
  float h;          // row height factor (1: the full 0.42 m ridge)
  float w;          // row width factor
  vec3 col;         // the rows' colour
  vec3 soil;        // the bed between them
  float flower;     // share of the rows in flower (fragment specks)
  vec3 flowerCol;
  float id;         // the crop (cropOf), for the plants' look in the fragment
};
Crop gCrop;
varying vec4 vCropFlower; // rgb flower colour, a: share in flower
varying float vCropH;
varying float vCropId;

float cropHash(float a, float b) { return fract(sin(a * 127.1 + b * 311.7) * 43758.5453); }
float rampC(float a, float b, float t) { return smoothstep(a, b, t); }
float windowC(float a, float b, float c, float d, float t) { return smoothstep(a, b, t) * (1.0 - smoothstep(c, d, t)); }

// The crop in a row of a field in a given year.
float cropOf(float kind, float era, float seed, float row, float year) {
  if (kind > 2.5) return 8.0;
  if (kind > 1.5) return 7.0;
  if (kind > 0.5) return 6.0;
  float strips = era < 1.5 ? 1.0 : 0.0;
  float s = floor(seed * 12.0) + strips * floor(row / 3.0);
  if (strips > 0.5) {
    float c = mod(year + s, 3.0);
    return c < 0.5 ? 0.0 : c < 1.5 ? 1.0 : 3.0;
  }
  float c = mod(year + s, 4.0);
  float crop = c < 0.5 ? 0.0 : c < 1.5 ? 2.0 : c < 2.5 ? 1.0 : 3.0;
  float r = cropHash(seed * 91.0 + 3.0, year);
  if (crop == 3.0 && era > 1.5 && r < 0.35) crop = 4.0;
  if (crop == 1.0 && era > 3.5 && r < 0.5) crop = 5.0;
  return crop;
}
bool winterSown(float crop) { return crop == 0.0 || crop == 5.0; }
bool sward(float crop) { return crop == 3.0 || crop > 6.5; }

const vec3 C_SPROUT = vec3(0.22, 0.42, 0.10);
const vec3 C_GREEN = vec3(0.30, 0.46, 0.12);
const vec3 C_GOLD = vec3(0.70, 0.52, 0.16);
const vec3 C_PALE = vec3(0.74, 0.62, 0.30);
const vec3 C_STRAW = vec3(0.58, 0.47, 0.24);
const vec3 S_WORKED = vec3(0.17, 0.11, 0.06);
const vec3 S_PLOUGHED = vec3(0.115, 0.075, 0.045);
const vec3 S_STUBBLE = vec3(0.36, 0.29, 0.15);
const vec3 S_GRASS = vec3(0.13, 0.24, 0.06);
const vec3 S_WINTER_GRASS = vec3(0.17, 0.21, 0.09);

// Cut at \`cut\`: stubble, with the stooks (where \`stook\`) standing until \`clear\`.
float harvested(float h, float t, float cut, float clear, float stook) {
  float k = rampC(cut, cut + 0.015, t);
  float stand = stook * (1.0 - rampC(clear - 0.02, clear, t));
  return mix(h, mix(0.1, 0.62, stand), k);
}

// One crop's look at time of year t (before the winter rule).
Crop cropAt(float crop, float t, float stook, float bump, float rowSeed, float seed, float era) {
  Crop c;
  c.h = 0.0; c.w = 1.0; c.col = C_GREEN; c.soil = S_WORKED; c.flower = 0.0; c.flowerCol = vec3(1.0);
  if (crop == 0.0) {                 // wheat, sown the autumn before
    c.h = mix(0.18, 1.0, rampC(0.0, 0.3, t));
    c.col = mix(C_SPROUT, C_GREEN, rampC(0.02, 0.2, t));
    c.col = mix(c.col, C_GOLD, rampC(0.36 + seed * 0.06, 0.52, t));
    c.h = harvested(c.h, t, 0.585, 0.7, stook);
    float cut = rampC(0.585, 0.6, t);
    c.col = mix(c.col, mix(C_STRAW, C_GOLD, stook), cut);
    c.soil = mix(S_WORKED, S_STUBBLE, cut);
  } else if (crop == 1.0) {          // barley, spring sown, pale when ripe
    c.h = 0.85 * rampC(0.04, 0.3, t);
    c.col = mix(C_SPROUT, C_GREEN, rampC(0.06, 0.2, t));
    c.col = mix(c.col, C_PALE, rampC(0.34 + seed * 0.05, 0.47, t));
    c.h = harvested(c.h, t, 0.5, 0.62, stook);
    float cut = rampC(0.5, 0.515, t);
    c.col = mix(c.col, C_STRAW, cut);
    c.soil = mix(S_WORKED, S_STUBBLE, cut);
  } else if (crop == 2.0) {          // roots: low, leafy, lifted in late autumn
    c.h = 0.55 * rampC(0.08, 0.3, t) * (0.75 + 0.25 * bump) * (1.0 - rampC(0.72, 0.75, t));
    c.w = 1.35;
    c.col = mix(vec3(0.10, 0.24, 0.13), vec3(0.20, 0.27, 0.10), rampC(0.5, 0.7, t));
  } else if (crop == 3.0) {          // clover ley (fallow in the open fields): a sward, mown for hay
    float fallow = era < 1.5 ? 1.0 : 0.0;
    c.h = 0.22 + 0.16 * rampC(0.05, 0.25, t);
    c.h = harvested(c.h, t, 0.42, 0.52, stook);
    c.w = 1.6;
    c.col = mix(vec3(0.16, 0.32, 0.08), vec3(0.26, 0.32, 0.10), fallow);
    c.col = mix(c.col, C_STRAW * 0.9, rampC(0.42, 0.44, t) * stook);
    c.soil = S_GRASS;
    c.flower = windowC(0.17, 0.22, 0.38, 0.42, t) * (fallow > 0.5 ? 0.35 : 0.6);
    c.flowerCol = fallow > 0.5 ? vec3(0.62, 0.07, 0.04) : mix(vec3(0.55, 0.22, 0.40), vec3(0.85, 0.84, 0.78), step(0.6, rowSeed));
  } else if (crop == 4.0) {          // flax: blue in flower, then gold-brown, pulled and stooked
    c.h = 0.75 * rampC(0.04, 0.25, t);
    c.col = mix(C_GREEN, vec3(0.50, 0.40, 0.18), rampC(0.33, 0.44, t));
    c.h = harvested(c.h, t, 0.47, 0.58, stook);
    c.flower = windowC(0.19, 0.22, 0.29, 0.32, t) * 0.8;
    c.flowerCol = vec3(0.26, 0.38, 0.72);
  } else if (crop == 5.0) {          // rapeseed: sown in autumn, a blaze of yellow in spring
    c.h = mix(0.2, 1.0, rampC(0.0, 0.12, t));
    c.col = mix(C_GREEN, vec3(0.34, 0.36, 0.14), rampC(0.24, 0.32, t));
    c.col = mix(c.col, vec3(0.40, 0.31, 0.15), rampC(0.34, 0.42, t));
    c.h = harvested(c.h, t, 0.44, 0.5, 0.0);
    c.flower = windowC(0.05, 0.08, 0.18, 0.22, t);
    c.flowerCol = vec3(0.86, 0.70, 0.06);
    c.soil = mix(S_WORKED, S_STUBBLE, rampC(0.44, 0.46, t));
  } else if (crop == 6.0) {          // a vegetable a row, sown in turn
    float v = floor(rowSeed * 5.0);
    float sow = 0.04 + rowSeed * 0.1;
    float grow = rampC(sow, sow + 0.18, t);
    c.soil = vec3(0.14, 0.09, 0.05);
    if (v < 0.5) {                   // cabbages: round heads, blue-green
      c.h = 0.55 * grow * (0.55 + 0.45 * bump); c.w = 1.25; c.col = vec3(0.14, 0.25, 0.18);
    } else if (v < 1.5) {            // leeks: upright, grey-green
      c.h = 0.8 * grow; c.w = 0.45; c.col = vec3(0.22, 0.32, 0.17);
    } else if (v < 2.5) {            // carrots: feathery, bright, lifted in autumn
      c.h = 0.4 * grow * (1.0 - rampC(0.62, 0.66, t)); c.w = 1.1; c.col = vec3(0.21, 0.42, 0.08);
    } else if (v < 3.5) {            // runner beans: tall rows in summer, red flowers
      c.h = 1.7 * rampC(sow + 0.08, sow + 0.25, t) * (1.0 - rampC(0.6, 0.64, t)); c.w = 0.75; c.col = vec3(0.10, 0.24, 0.07);
      c.flower = windowC(0.24, 0.27, 0.4, 0.45, t) * 0.5; c.flowerCol = vec3(0.70, 0.12, 0.06);
    } else {                         // potatoes: bushy, white flowers, lifted after summer
      c.h = 0.5 * grow * (1.0 - rampC(0.52, 0.56, t)); c.w = 1.35; c.col = mix(vec3(0.16, 0.30, 0.10), vec3(0.30, 0.30, 0.12), rampC(0.44, 0.52, t));
      c.flower = windowC(0.26, 0.29, 0.34, 0.37, t) * 0.5; c.flowerCol = vec3(0.86, 0.84, 0.80);
    }
  } else {                           // orchard sward and pasture: short grass all year
    // Close to the meadow's own green, so the lot reads as grass, not rows.
    bool pasture = crop > 7.5;
    c.h = pasture ? 0.06 + 0.03 * bump : 0.12;
    c.w = 1.8;
    c.col = pasture ? vec3(0.13, 0.25, 0.06) : vec3(0.14, 0.26, 0.065);
    c.soil = pasture ? vec3(0.12, 0.23, 0.055) : S_GRASS;
    c.flower = windowC(0.1, 0.13, 0.26, 0.3, t) * (pasture ? 0.3 : 0.2);
    c.flowerCol = pasture ? vec3(0.82, 0.68, 0.05) : vec3(0.88, 0.87, 0.80);
  }
  return c;
}

// The field at this vertex now: this year's crop until the autumn ploughing,
// then (from 0.78) next year's winter-sown crop sprouting, or bare furrows.
Crop cropNow(vec3 position, float kind, float era, float seed) {
  float t = uYearT;
  float year = uYear;
  float row = clamp(floor((position.z + 0.5) * ${FIELD_ROWS}.0), 0.0, ${FIELD_ROWS - 1}.0);
  float k = floor((position.x + 0.47) / 0.94 * ${FIELD_SEG}.0 + 0.5);
  float rowSeed = cropHash(seed * 53.0 + row, kind > 0.5 && kind < 1.5 ? year : 0.0);
  // Sheaves stand in stooks until the Industrial era; after it, round bales
  // on the stubble (decor.js) and none in the rows.
  // A few, scattered: every fifth vertex of every other row, so the cut
  // field reads as stubble with stooks standing about it, not a field of hay.
  float stook = step(mod(k + floor(rowSeed * 5.0), 5.0), 0.5) * step(0.5, mod(row, 2.0)) * (1.0 - step(3.5, era));
  float bump = mod(k, 2.0);
  float crop = cropOf(kind, era, seed, row, year);
  Crop c = cropAt(crop, t, stook, bump, rowSeed, seed, era);
  c.id = crop;
  // A sward sown this spring (after another crop) comes up rather than appearing.
  if (sward(crop) && crop < 6.5 && cropOf(kind, era, seed, row, year - 1.0) != crop) c.h *= rampC(0.0, 0.1, t);
  float winter = rampC(0.76, 0.8, t);
  if (winter > 0.0) {
    Crop w = c;
    if (sward(crop)) {
      w.h = c.h * 0.7;
      w.col = mix(c.col, vec3(0.20, 0.24, 0.10), 0.6);
      w.soil = S_WINTER_GRASS;
      w.flower = 0.0;
    } else if (crop == 6.0) {
      float v = floor(rowSeed * 5.0);
      w.h = v < 1.5 ? c.h * 0.8 : 0.0;
    } else {
      float next = cropOf(kind, era, seed, row, year + 1.0);
      w.h = winterSown(next) ? 0.18 * rampC(0.82, 0.92, t) : 0.0;
      w.col = C_SPROUT;
      w.soil = S_PLOUGHED;
      w.flower = 0.0;
    }
    c.h = mix(c.h, w.h, winter);
    c.col = mix(c.col, w.col, winter);
    c.soil = mix(c.soil, w.soil, winter);
    c.flower *= 1.0 - winter;
  }
  // Fresh furrows: dark, newly turned soil for a few weeks after ploughing.
  if (!sward(crop) && crop != 6.0) c.soil = mix(c.soil, S_PLOUGHED, rampC(0.72, 0.76, t) * (1.0 - winter));
  c.col *= 0.9 + 0.2 * seed;
  return c;
}
#endif
`;
