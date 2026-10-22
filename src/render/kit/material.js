import * as THREE from 'three';
import { patchMaterial, NOISE, GRADE_HEAD, MICRO_ARB, SPEC_HEAD, SPEC_PARS, SPEC_NORMAL, SPEC_END } from '../shaderlib.js';
import { GROUND_GLSL } from '../ground.js';
import { CROP_GLSL, FIELD_ROWS } from './crops.js';

// The building material: Lambert, patched so every face picks its colour
// family from aPart and the instance colours, and walls draw analytic
// facades (windows, doors, timber framing, quoins) with no textures.
// The same vertex offset code is shared with the shadow depth material, so
// shadows match the drawn shape (eaves, poles and caps included).

const VERTEX_HEAD = /* glsl */ `
attribute vec3 aMetric;
attribute vec3 aShape;
attribute vec2 aPartAO;
attribute vec3 iRoof;
attribute vec3 iTrim;
attribute vec4 iParams;
attribute vec4 iStyle;
attribute vec4 iShape;
uniform float uDetailDist;
${GROUND_GLSL}
`;

// Adds metric offsets after the unit-space scale, so eaves, caps and poles
// keep their size in metres. Hidden instances (zero scale) collapse to a point.
const VERTEX_OFFSET = /* glsl */ `
  vec3 iScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  float aliveI = step(1e-3, iScale.x * iScale.y * iScale.z);
  vec3 metric = aMetric + aShape * vec3(iShape.y, iShape.z, iShape.y);
  #ifdef CROP_PIECE
    // What grows in this row now (crops.js): its height and width.
    gCrop = cropNow(position, iStyle.z, iStyle.x, iParams.w);
    if (aPartAO.x > 6.5 && aPartAO.x < 7.5) {
      // A row keeps to its own lane, never wider than the gap to the next, so
      // neighbouring ridges never cross at a shallow angle (they flickered at
      // low heights). Its foot is tucked just under the bed, and an empty row
      // (cut, ploughed, lifted) sinks out of sight instead of lying flat on
      // the soil, where the two surfaces fought.
      float lane = 0.46 * iScale.z / ${FIELD_ROWS.toFixed(1)};
      metric.z = clamp(metric.z * gCrop.w, -lane, lane);
      metric.y = gCrop.h < 0.05 ? -0.12 : aMetric.y > 0.0 ? metric.y * gCrop.h : -0.02;
    }
    vCropFlower = vec4(gCrop.flowerCol, gCrop.flower);
    vCropH = gCrop.h;
    vCropId = gCrop.id;
  #endif
  #ifdef ROTOR
    // Windmill sails turn about the hub (local z axis), speed by wind.
    float ang = uDecoTime * (0.55 + 0.5 * length(uWind)) + iParams.w * 6.283;
    float ca = cos(ang), sa = sin(ang);
    transformed.xy = mat2(ca, sa, -sa, ca) * transformed.xy;
  #endif
  transformed += metric / max(iScale, vec3(1e-4));
  #ifdef CROP_PIECE
    // Drape: every field vertex sits on the shared ground height (the same
    // texture the terrain mesh uses), lifted by its crop height.
    vec3 wposC = (instanceMatrix * vec4(transformed, 1.0)).xyz;
    float gy = groundHeight(wposC.xz) + metric.y + 0.05;
    transformed.y = (gy - instanceMatrix[3].y) / max(iScale.y, 1e-4);
  #endif
  #ifdef DETAIL_PIECE
    // Small details vanish beyond the detail distance (no CPU LOD needed).
    vec3 ipos = instanceMatrix[3].xyz;
    aliveI *= step(distance(ipos, cameraPosition), uDetailDist);
  #endif
  transformed *= aliveI;
`;

const VERTEX_NORMAL = /* glsl */ `
  #ifdef ROTOR
    float angN = uDecoTime * (0.55 + 0.5 * length(uWind)) + iParams.w * 6.283;
    float cn = cos(angN), sn = sin(angN);
    objectNormal.xy = mat2(cn, sn, -sn, cn) * objectNormal.xy;
  #endif
`;

const VERTEX_VARYINGS = /* glsl */ `
varying vec3 vBase;
varying vec3 vTrimC;
varying vec3 vLocal;
varying vec3 vObjN;
varying vec3 vScale;
varying vec2 vPartAO;
varying vec4 vParams;
varying vec4 vStyle;
varying vec4 vShapeV;
varying vec3 vWorldP;
varying float vUpW;
`;

const VERTEX_END = /* glsl */ `
  vScale = iScale;
  vLocal = position * iScale + metric;
  vObjN = normal;
  vPartAO = aPartAO;
  vParams = iParams;
  vStyle = iStyle;
  vShapeV = iShape;
  vTrimC = iTrim;
  vec4 wp = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
  vWorldP = wp.xyz;
  // Normals transform by the inverse transpose: divide by scale squared first.
  vUpW = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * (objectNormal / max(iScale * iScale, vec3(1e-6)))).y;
  // Base colour per part (constant over a face, so pick it per vertex).
  float part = aPartAO.x;
  vec3 wall = instanceColor;
  vec3 base = wall;
  if (part > 0.5 && part < 1.5) base = iRoof;
  else if (part > 1.5 && part < 2.5) base = iTrim;
  else if (part > 2.5 && part < 3.5) base = vec3(0.16, 0.10, 0.06) * (0.85 + 0.3 * iParams.w);
  else if (part > 3.5 && part < 4.5) base = wall * 0.5;
  else if (part > 4.5 && part < 5.5) base = accentColor(iStyle.y);
  else if (part > 5.5 && part < 6.5) base = vec3(0.12, 0.17, 0.19);
  else if (part > 6.5 && part < 7.5) base = cropColor(uYearT, iParams.w);
  #ifdef CROP_PIECE
    if (part > 6.5 && part < 7.5) base = gCrop.col;
    else if (part > 3.5 && part < 4.5) base = gCrop.soil;
  #endif
  vBase = base;
`;

// Small palette helpers shared by vertex code.
const PALETTE_GLSL = /* glsl */ `
uniform float uYearT;
vec3 accentColor(float i) {
  // Muted accents: rust, moss green, river blue, ochre, plum, cream, faded red.
  i = mod(floor(i + 0.5), 7.0);
  if (i < 0.5) return vec3(0.45, 0.12, 0.07);
  if (i < 1.5) return vec3(0.15, 0.25, 0.10);
  if (i < 2.5) return vec3(0.10, 0.22, 0.32);
  if (i < 3.5) return vec3(0.62, 0.40, 0.08);
  if (i < 4.5) return vec3(0.26, 0.10, 0.20);
  if (i < 5.5) return vec3(0.80, 0.72, 0.55);
  return vec3(0.58, 0.16, 0.10);
}
vec3 cropColor(float yt, float seed) {
  vec3 sprout = vec3(0.22, 0.42, 0.10);
  vec3 green = vec3(0.30, 0.46, 0.12);
  vec3 gold = vec3(0.70, 0.52, 0.16);
  vec3 stubble = vec3(0.55, 0.43, 0.22);
  vec3 c = mix(sprout, green, smoothstep(0.05, 0.25, yt));
  c = mix(c, gold, smoothstep(0.38 + seed * 0.08, 0.58, yt));
  c = mix(c, stubble, smoothstep(0.66, 0.72, yt));
  return c * (0.9 + 0.2 * seed);
}
`;

const FRAGMENT_HEAD = /* glsl */ `
${VERTEX_VARYINGS}
${NOISE}
uniform float uYearT;
uniform vec3 uSkyHorizon;
uniform float uFacadeFade;

// Anti-aliased box mask: 1 inside |p| < h, soft by one pixel.
float boxMask(vec2 p, vec2 h) {
  vec2 w = fwidth(p) * 0.75 + 1e-4;
  vec2 m = smoothstep(h + w, h - w, abs(p));
  return m.x * m.y;
}

#ifdef SPECULAR
// Which pane of glass this fragment is in (facade() sets it): the window's
// column and storey, and its side of each glazing bar.
vec4 gPane = vec4(0.0);
#endif

// Facade: returns (glass, frame, door, lit) masks for a wall fragment.
// s = horizontal metres along the face (centred), h = metres above the ground
// floor, len = face width, F = storey height.
vec4 facade(float s, float h, float len, float F, float kind, float seed, float isFront, float topH, out float shutter, out float halo) {
  shutter = 0.0;
  halo = 0.0;
  if (kind < 0.5 || len < 1.8 || h < 0.0 || h > topH) return vec4(0.0);
  float spacing = 2.6; vec2 win = vec2(0.42, 0.48); float sill = 0.95;
  if (kind > 1.5) { spacing = 2.2; win = vec2(0.44, 0.78); sill = 0.85; }
  if (kind > 2.5) { spacing = 2.5; win = vec2(0.52, 1.0); sill = 0.75; }
  if (kind > 5.5) { spacing = 2.1; win = vec2(0.72, 0.9); sill = 0.8; }
  if (kind > 6.5) { spacing = 2.8; win = vec2(0.32, 1.7); sill = 1.6; F = max(F, topH); }
  float n = max(1.0, floor((len - 0.8) / spacing));
  float c = len / n;
  float col = floor((s + len * 0.5) / c);
  float u = s + len * 0.5 - (col + 0.5) * c;
  float floorI = floor(h / F);
  float v = h - floorI * F;
  float center = sill + win.y;
  float glass = 0.0;
  float frame = 0.0;
  if (kind > 3.5 && kind < 4.5) {
    // Glass bands with slim mullions every 1.4 m.
    float band = boxMask(vec2(0.0, v - 1.75), vec2(1e3, 0.95));
    float edge = boxMask(vec2(s, 0.0), vec2(len * 0.5 - 0.35, 1e3));
    float mull = 1.0 - boxMask(vec2(fract(s / 1.4 + 0.5) - 0.5, 0.0), vec2(0.035, 1e3));
    glass = band * edge * mull;
    frame = band * edge * (1.0 - mull);
    #ifdef SPECULAR
      gPane = vec4(floor(s / 1.4 + 0.5), floor(h / F), 0.0, 0.0);
    #endif
  } else {
    bool shopFloor = kind > 4.5 && kind < 5.5 && floorI < 0.5;
    vec2 w = win;
    float cy = center;
    if (shopFloor) { w = vec2(c * 0.36, 1.0); cy = 1.4; }
    vec2 p = vec2(u, v - cy);
    if (kind > 6.5) {
      // Lancet: narrows to a point in the top third.
      float t = clamp((p.y - w.y * 0.4) / (w.y * 0.6), 0.0, 1.0);
      w.x *= 1.0 - t * t;
    }
    glass = boxMask(p, w);
    frame = boxMask(p, w + vec2(0.12, 0.12)) - glass;
    // Stone lintel above and a sill below sash and tall windows.
    if (kind > 1.5 && kind < 3.5 || (kind > 4.5 && kind < 5.5 && !shopFloor)) {
      frame = max(frame, boxMask(vec2(p.x, p.y - w.y - 0.2), vec2(w.x + 0.2, 0.09)));
      frame = max(frame, boxMask(vec2(p.x, p.y + w.y + 0.1), vec2(w.x + 0.16, 0.05)));
    }
    // Warm spill around the opening, used at night.
    halo = (1.0 - smoothstep(0.0, 0.9, length(max(abs(p) - w, 0.0)))) * (1.0 - glass);
    // Glazing bars on sash and industrial windows.
    if (kind > 1.5 && !shopFloor) {
      float bars = max(1.0 - boxMask(vec2(p.x, 0.0), vec2(0.03, 1e3)), 0.0);
      bars *= 1.0 - boxMask(vec2(0.0, p.y + (kind > 5.5 ? 0.3 : 0.0)), vec2(1e3, 0.03));
      frame += glass * (1.0 - bars);
      glass *= bars;
    }
    #ifdef SPECULAR
      gPane = vec4(col, floorI, step(0.0, p.x), step(kind > 5.5 ? -0.3 : 0.0, p.y)) * (kind > 1.5 && !shopFloor ? vec4(1.0) : vec4(1.0, 1.0, 0.0, 0.0));
    #endif
    // Cottage shutters either side of the window.
    if (kind < 1.5) shutter = boxMask(vec2(abs(p.x) - w.x - 0.24, p.y), vec2(0.2, w.y));
  }
  // Keep corners clear.
  float inside = boxMask(vec2(s, 0.0), vec2(len * 0.5 - 0.45, 1e3));
  glass *= inside; frame *= inside; shutter *= inside; halo *= inside;
  // Front door: the column nearest the middle, on the ground floor.
  float door = 0.0;
  if (isFront > 0.5 && floorI < 0.5) {
    float doorX = (floor(n * 0.5) + 0.5) * c - len * 0.5;
    vec2 dp = vec2(s - doorX, h - 1.08);
    door = boxMask(dp, vec2(0.52, 1.08));
    float dframe = boxMask(dp, vec2(0.64, 1.18)) - door;
    float inCol = boxMask(vec2(s - doorX, 0.0), vec2(c * 0.5, 1e3));
    glass *= 1.0 - inCol; shutter *= 1.0 - inCol;
    frame = max(frame * (1.0 - inCol), dframe);
  }
  // A stable per-window random decides which rooms are lit at night.
  float lit = step(0.32, hash12(vec2(col + seed * 37.0, floorI + seed * 11.0)));
  return vec4(glass, frame, door, lit);
}
`;

const FRAGMENT_COLOR = /* glsl */ `
  #ifdef MICRO_DETAIL
    // Micro-detail (docs/design/micro-detail.md): screen derivatives of the
    // instance-frame position and the view position, taken here where control
    // flow is uniform. Pattern code adds the gradient of its analytic height
    // (per metre of vLocal) to mGradL; FRAGMENT_NORMAL chains it to screen
    // space and tilts the normal.
    vec3 mLdx = dFdx(vLocal), mLdy = dFdy(vLocal);
    vec3 mPdx = dFdx(-vViewPosition), mPdy = dFdy(-vViewPosition);
    vec3 mGradL = vec3(0.0);
  #endif
  float part = vPartAO.x;
  vec3 col = vBase;
  // params.y = lit (0/1) + 2 when the lot is selected.
  float litI = mod(vParams.y, 2.0);
  float selectedI = step(1.5, vParams.y);
  float seed = vParams.w;
  float condition = vParams.x;
  float age = vParams.z;
  float wealth = vShapeV.w;
  vec3 N = normalize(vObjN);
  float emissive = 0.0;
  vec3 glowCol = vec3(1.0, 0.72, 0.42);
  float facadeOn = uFacadeFade * (1.0 - smoothstep(240.0, 360.0, length(vWorldP - cameraPosition)));

  bool isWall = part < 0.5;
  bool isRoof = part > 0.5 && part < 1.5;
  bool isStone = part > 7.5;
  // Wind over the crops: brighter bands roll across a standing field along
  // the wind, as the stems bend and show their paler sides.
  if (part > 6.5 && part < 7.5 && uWeatherDetail > 0.5) {
    float windL = length(uWind);
    vec2 wd = uWind / max(windL, 1e-3);
    float along = dot(vWorldP.xz, wd);
    float wave = sin(along * 0.35 - uDecoTime * (1.6 + windL) + vnoise(vWorldP.xz * 0.08) * 4.0);
    #ifdef CROP_PIECE
      float standing = smoothstep(0.5, 0.8, vCropH);
    #else
      float standing = smoothstep(0.15, 0.3, uYearT) * (1.0 - smoothstep(0.64, 0.7, uYearT));
    #endif
    col *= 1.0 + 0.11 * smoothstep(0.2, 1.0, wave) * standing * (0.5 + windL);
  }

  if (isWall || isStone) {
    float h = vLocal.y - vShapeV.x; // metres above the ground floor
    float F = vStyle.x;
    float flags = vStyle.w;
    bool side = abs(N.x) > 0.5;
    bool vertical = abs(N.y) < 0.5;
    float s = side ? vLocal.z * sign(N.x) * -1.0 : vLocal.x * sign(N.z);
    float len = side ? vScale.z : vScale.x;
    // Fake sky occlusion: walls darken toward the ground.
    col *= 0.86 + 0.14 * smoothstep(0.0, 1.6, h);
    if (vertical && isWall) {
      // Plinth band.
      if (mod(flags, 16.0) >= 8.0) col = mix(col, col * 0.72, step(h, 0.42));
      // Weatherboard / timber cladding lines.
      if (mod(flags, 32.0) >= 16.0) col *= 1.0 - 0.18 * smoothstep(0.035, 0.0, abs(fract(h / 0.3) - 0.5) - 0.44);
      // Half-timbering: dark posts, rails and knee braces on the upper storey(s).
      if (mod(flags, 2.0) >= 1.0 && (h > F - 0.1 || vStyle.x < 2.75)) {
        float panel = 1.15;
        float pu = fract(s / panel + 0.5) - 0.5;
        float pv = mod(h, F);
        float post = 1.0 - smoothstep(0.06, 0.09, abs(pu) * panel);
        float rail = 1.0 - smoothstep(0.07, 0.1, abs(pv - 0.05));
        float mid = 1.0 - smoothstep(0.05, 0.08, abs(pv - F * 0.52));
        float brace = (1.0 - smoothstep(0.05, 0.08, abs((pu + 0.5) * panel - pv * 0.55))) * step(pv, F * 0.5) * step(mod(floor(s / panel + 0.5), 2.0), 0.5);
        float timber = max(max(post, rail), max(mid, brace)) * facadeOn;
        col = mix(col, vec3(0.16, 0.10, 0.06), timber * 0.92);
      }
      // Quoins: alternating dressed blocks at the corners.
      if (mod(flags, 4.0) >= 2.0) {
        float row = floor(h / 0.34);
        float qw = mod(row, 2.0) < 0.5 ? 0.46 : 0.3;
        float q = smoothstep(len * 0.5 - qw - 0.02, len * 0.5 - qw, abs(s)) * step(0.0, h);
        col = mix(col, vTrimC * 0.95, q * 0.85);
      }
      // String course at each floor line.
      if (mod(flags, 8.0) >= 4.0) {
        float fl = mod(h + 0.06, F);
        col = mix(col, vTrimC, (1.0 - smoothstep(0.1, 0.13, fl)) * step(F * 0.9, h) * facadeOn);
      }
      // Weathering: vertical grime streaks grow as condition falls; age darkens.
      float streak = vnoise(vec2((vLocal.x + vLocal.z) * 1.7 + seed * 13.0, h * 0.35));
      float streakAA = smoothstep(4.0, 10.0, 1.0 / max(fwidth(vLocal.x + vLocal.z), 1e-4));
      col *= 1.0 - 0.28 * (1.0 - condition) * smoothstep(0.35, 0.8, mix(0.5, streak, streakAA));
      // Lichen on old stone.
      col = mix(col, col * vec3(0.86, 0.95, 0.78), smoothstep(0.45, 0.9, age) * smoothstep(0.5, 0.8, vnoise(vLocal.xy * 0.9 + seed * 7.0)) * 0.6);

      float shutter, halo;
      bool front = N.z > 0.5 && mod(flags, 64.0) < 32.0;
      vec4 fz = facade(s, h, len, F, vStyle.y, seed, front ? 1.0 : 0.0, vScale.y - vShapeV.x - 0.35, shutter, halo);
      // Below ~4 px per metre, window detail aliases into speckle: fade it to
      // a slightly darker average instead.
      float pxPerM = 1.0 / max(max(fwidth(s), fwidth(h)), 1e-4);
      float sharp = smoothstep(2.5, 6.0, pxPerM);
      col *= 1.0 - 0.1 * (1.0 - sharp) * step(0.5, vStyle.y);
      #ifdef SPECULAR
        // Window glass (docs/design/micro-detail.md §6): a near mirror. Each
        // pane leans a few degrees its own way, like old crown glass, so a
        // low sun catches some panes and not their neighbours. Once the
        // windows blur (sharp), the glass is spread over the wall as its
        // average share, unlit by panes, so it cannot sparkle. The sun glint
        // is the mirrored stand-in (gSpecMirror) and only for a low sun.
        gSpecK = mix(0.12 * step(0.5, vStyle.y), fz.x, sharp) * facadeOn * step(0.15, condition);
        gSpecMirror = 1.0 - smoothstep(0.3, 0.5, uSunDir.y);
        gSpecRough = 0.24;
        gSpecF0 = 0.04;
        vec2 pane = gPane.xy * 3.0 + gPane.zw + seed * 17.0 + (side ? 41.0 : 0.0) + (N.z + N.x < 0.0 ? 23.0 : 0.0);
        gSpecTilt = (vec2(hash12(pane), hash12(pane + 5.3)) - 0.5) * 0.12 * sharp;
      #endif
      fz.xyz *= facadeOn * sharp;
      shutter *= facadeOn * sharp;
      halo *= facadeOn;
      // Window frames in trim colour, shutters and doors in an accent.
      col = mix(col, vTrimC, clamp(fz.y, 0.0, 1.0));
      vec3 accent = accentColor(floor(seed * 7.0));
      col = mix(col, accent * 1.1, shutter * 0.9);
      col = mix(col, accent * 0.8, fz.z);
      // Glass: dark with a faint sky sheen higher up.
      vec3 glass = mix(vec3(0.07, 0.10, 0.12), uSkyHorizon * 0.45, 0.25 + 0.25 * fract(h / F));
      float lit = fz.w * litI;
      col = mix(col, glass, fz.x);
      emissive = fz.x * lit + halo * lit * 0.12;
      // Shuttered and shabby: closed windows when condition is very low.
      col = mix(col, vec3(0.2, 0.15, 0.1), fz.x * step(condition, 0.15));
      emissive *= step(0.15, condition);
    }
  } else if (isRoof) {
    float rk = vStyle.z;
    float h = vLocal.y;
    float ridge = vScale.y - h;
    float n1 = vnoise(vec2(vLocal.x * 2.6, h * 1.2) + seed * 17.0);
    if (rk < 0.5) {
      // Thatch: combed vertical streaks, soft layered courses and a ridge roll.
      float streaks = vnoise(vec2(vLocal.x * 6.0 + vLocal.z * 6.0, h * 0.6));
      col *= 0.86 + 0.24 * streaks;
      col *= 1.0 - 0.1 * smoothstep(0.2, 0.0, abs(fract(h / 0.55) - 0.5) - 0.3);
      col = mix(col, col * 0.82, smoothstep(0.42, 0.3, ridge) * step(0.0, ridge));
    } else if (rk < 3.5) {
      // Tile, slate and shingle courses: dark lines at each course,
      // staggered joints, a little per-slate shade variation.
      float course = rk < 1.5 ? 0.3 : (rk < 2.5 ? 0.24 : 0.26);
      float cy = h / course;
      float row = floor(cy);
      float line = smoothstep(0.1, 0.0, fract(cy)) * facadeOn;
      float jx = (vLocal.x + vLocal.z) / (course * 1.1) + mod(row, 2.0) * 0.5;
      float joint = smoothstep(0.06, 0.0, abs(fract(jx) - 0.5) - 0.44) * facadeOn;
      float shade = hash12(vec2(floor(jx), row) + seed * 5.0);
      // Fade per-slate detail once a course is only a few pixels tall.
      float roofSharp = smoothstep(3.0, 8.0, course / max(fwidth(h), 1e-4));
      col *= 1.0 - (0.2 * line + 0.08 * joint) * roofSharp;
      col *= 0.92 + (rk > 1.5 ? 0.16 : 0.1) * mix(0.5, shade, roofSharp);
      #ifdef MICRO_DETAIL
        // Relief: each course laps the one below, so a tile's height above the
        // roof plane falls from lap at its butt to 0 at its head, then steps
        // up at the next course line; the staggered joints are grooves half
        // as deep. The butt edge and the groove walls are never narrower than
        // 1.5 px, and the whole slope fades with roofSharp.
        float mFade = roofSharp * facadeOn;
        if (mFade > 0.0) {
          float lap = rk < 1.5 ? 0.015 : 0.008;
          float t = fract(cy);
          float e = max(0.06, 1.5 * (abs(mLdx.y) + abs(mLdy.y)) / course);
          float u = min(t / e, 1.0);
          float sE = u * u * (3.0 - 2.0 * u);
          // H = lap (1 - t) smoothstep(0, e, t)
          float dHdcy = lap * ((1.0 - t) * 6.0 * u * (1.0 - u) / e - sE);
          float fj = fract(jx) - 0.5;
          float wj = max(0.06, 1.5 * (abs(mLdx.x + mLdx.z) + abs(mLdy.x + mLdy.z)) / (course * 1.1));
          float v = min((0.5 - abs(fj)) / wj, 1.0);
          // H -= 0.5 lap (1 - smoothstep(0, wj, 0.5 - |fj|))
          float dHdjx = -0.5 * lap * 6.0 * v * (1.0 - v) / wj * sign(fj);
          mGradL += mFade * (vec3(0.0, dHdcy / course, 0.0) + vec3(dHdjx / (course * 1.1)) * vec3(1.0, 0.0, 1.0));
        }
      #endif
      #ifdef SPECULAR
        // Wet roofs: slate glossiest, then tile, then shingle; the course
        // lines and joints stay matte (faded by roofSharp, so the gloss
        // turns to its average with them).
        gSpecK = smoothstep(0.1, 0.6, uWet) * (rk < 1.5 ? 0.7 : rk < 2.5 ? 1.0 : 0.5) * (1.0 - 0.8 * max(line, joint) * roofSharp)
          * (1.0 - smoothstep(250.0, 400.0, length(vWorldP - cameraPosition)));
        gSpecRough = rk < 1.5 ? 0.32 : rk < 2.5 ? 0.2 : 0.42;
      #endif
      // Ridge tiles.
      col = mix(col, col * 0.7, smoothstep(0.16, 0.12, ridge) * step(0.0, ridge));
    } else {
      // Flat roofs: gravel or planting inside a pale coping band.
      float ex = vScale.x * 0.5 - abs(vLocal.x);
      float ez = vScale.z * 0.5 - abs(vLocal.z);
      float coping = 1.0 - smoothstep(0.28, 0.34, min(ex, ez));
      if (rk > 4.5 && rk < 5.5) col *= 0.82 + 0.3 * vnoise(vLocal.xz * 1.4 + seed * 9.0);
      else col *= 0.9 + 0.12 * hash12(floor(vLocal.xz * 4.0));
      col = mix(col, vTrimC * 0.9, coping);
    }
    // Moss on old roofs, patchy gaps on neglected ones.
    col = mix(col, col * vec3(0.8, 0.92, 0.62), smoothstep(0.6, 1.0, age) * smoothstep(0.62, 0.8, n1) * 0.5);
    col *= 1.0 - 0.35 * step(condition, 0.35) * smoothstep(0.7, 0.75, n1);
  } else if (part > 4.5 && part < 5.5) {
    // Awnings and banners: stripes of accent and cream.
    float stripe = step(0.5, fract(vLocal.x / 0.55 + 0.25));
    if (vStyle.w < 0.5) col = mix(col, vec3(0.80, 0.74, 0.60), stripe * 0.85);
  } else if (part > 5.5 && part < 6.5) {
    emissive = litI * 0.6;
  } else if (part > 6.5 && part < 7.5) {
    col *= 0.85 + 0.25 * vnoise(vLocal.xz * 0.9 + seed * 11.0);
    #ifdef CROP_PIECE
      // Plants, not a smooth ridge: stalks across grain rows with paler ears
      // at the top, leafy clumps in roots, greens and clover, fine flecks in a
      // sward; every row darker at its foot, where the leaves shade the soil.
      float relH = clamp(vLocal.y / max(0.42 * vCropH, 0.04), 0.0, 1.0);
      float cid = floor(vCropId + 0.5);
      if (cid < 1.5 || cid > 3.5 && cid < 4.5) {
        float stalk = abs(fract(vLocal.x * 7.0 + vnoise(vLocal.xz * 3.0) * 0.8) - 0.5) * 2.0;
        col *= 0.84 + 0.16 * smoothstep(0.15, 0.45, stalk);
        col = mix(col, col * 1.16 + vec3(0.035, 0.028, 0.0), smoothstep(0.62, 0.95, relH));
      } else if (cid < 6.5) {
        float leaf = vnoise(vLocal.xz * 9.0 + vec2(vLocal.y * 6.0, seed * 13.0));
        col *= 0.78 + 0.34 * smoothstep(0.2, 0.75, leaf);
      } else {
        col *= 0.9 + 0.2 * hash12(floor(vLocal.xz * 24.0));
      }
      col *= 0.72 + 0.28 * smoothstep(0.0, 0.55, relH);
      // Flowers: specks over the share of the crop in bloom (all of a
      // rapeseed field at its peak, a scatter of clover or buttercups).
      float bloom = vnoise(vLocal.xz * 14.0 + seed * 7.0);
      col = mix(col, vCropFlower.rgb, smoothstep(1.0 - vCropFlower.a, 1.08 - vCropFlower.a, bloom));
    #endif
  }

  // Snow settles on up-facing surfaces (roofs, ledges, caps).
  float snow = smoothstep(0.25, 0.8, uSnow) * smoothstep(0.35, 0.7, vUpW);
  if (part > 6.5 && part < 7.5) snow *= 0.8;
  col = mix(col, vec3(0.90, 0.92, 0.95), snow * (0.85 + 0.15 * vnoise(vLocal.xz * 2.0)));
  #ifdef SPECULAR
    gSpecK *= (1.0 - snow) * step(uOverlay, 0.5);
  #endif

  // Baked ambient occlusion from the kit.
  col *= vPartAO.y;

  // Selected lot: a gentle warm brightening that breathes slowly.
  col = mix(col, col * 1.3 + vec3(0.05, 0.04, 0.02), selectedI * (0.55 + 0.2 * sin(uTime * 2.6)));

  // Overlays: value (wealth) and health (condition) ramps; roads mutes.
  if (uOverlay > 0.5) {
    float o = uOverlay < 1.5 ? wealth : condition;
    vec3 ramp = mix(vec3(0.62, 0.22, 0.14), vec3(0.85, 0.66, 0.2), smoothstep(0.0, 0.5, o));
    ramp = mix(ramp, vec3(0.28, 0.52, 0.24), smoothstep(0.5, 1.0, o));
    if (uOverlay > 1.5 && uOverlay < 2.5) ramp = vec3(dot(col, vec3(0.3, 0.55, 0.15))) * 1.1 + 0.1;
    col = mix(col, ramp * (isRoof ? 0.85 : 1.0), 0.85);
    emissive = 0.0;
  }
  diffuseColor.rgb = col * mix(uTint, vec3(1.0), snow * 0.7);
  gEmissive = emissive;
`;

const CROP_VARYINGS = /* glsl */ `
#ifdef CROP_PIECE
varying vec4 vCropFlower;
varying float vCropH;
varying float vCropId;
#endif
`;

// Micro-detail: the gradient the pattern code left in mGradL, chained to
// screen space through the derivatives taken at the top of FRAGMENT_COLOR.
const FRAGMENT_NORMAL = /* glsl */ `
  #ifdef MICRO_DETAIL
    if (mGradL != vec3(0.0)) normal = microPerturb(normal, mPdx, mPdy, vec2(dot(mGradL, mLdx), dot(mGradL, mLdy)), faceDirection);
  #endif
  #ifdef SPECULAR
${SPEC_NORMAL}
  #endif
`;

/** Uniforms shared by every kit material variant. */
export function createKitUniforms() {
  return {
    uDetailDist: { value: 230 },
    uFacadeFade: { value: 1 },
  };
}

/** Create the building material (one variant) and its shadow depth twin. */
export function createKitMaterials(grade, { variant = '', shared } = {}) {
  const defines = {};
  if (variant.includes('rotor')) defines.ROTOR = 1;
  if (variant.includes('crop')) defines.CROP_PIECE = 1;
  if (variant.includes('detail')) defines.DETAIL_PIECE = 1;

  const material = new THREE.MeshLambertMaterial({ color: 0xffffff, side: variant.includes('double') ? THREE.DoubleSide : THREE.FrontSide });
  // Fields lie a few centimetres over the terrain: pulled toward the eye in
  // depth as well, so the ground never flickers through the soil bed.
  if (defines.CROP_PIECE) Object.assign(material, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  patchMaterial(material, grade, {
    key: `kit:${variant}`,
    defines,
    uniforms: shared,
    vertexHead: VERTEX_HEAD + PALETTE_GLSL + CROP_GLSL + VERTEX_VARYINGS,
    vertexNormal: VERTEX_NORMAL,
    vertexBegin: VERTEX_OFFSET,
    vertexEnd: VERTEX_END,
    fragmentHead: FRAGMENT_HEAD + PALETTE_GLSL.replace('uniform float uYearT;', '') + CROP_VARYINGS + 'float gEmissive = 0.0;\n' + `#ifdef MICRO_DETAIL\n${MICRO_ARB}\n#endif\n`
      + `#ifdef SPECULAR\nuniform vec3 uSkyZenith;\n${SPEC_HEAD}\n#endif\n`,
    fragmentColor: FRAGMENT_COLOR,
    fragmentNormal: FRAGMENT_NORMAL,
    fragmentPars: `#ifdef SPECULAR\n${SPEC_PARS}\n#endif\n`,
    fragmentLights: `#ifdef SPECULAR\n${SPEC_END}\n#endif\n`,
    fragmentEmissive: /* glsl */ `
      // Lit windows glow warm at night; a dim glow at dusk.
      float nightW = smoothstep(0.25, 0.7, uNight);
      totalEmissiveRadiance += vec3(1.0, 0.68, 0.36) * gEmissive * nightW * 1.6;
    `,
  });
  // Shadow depth: same vertex displacement, no colour work.
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, grade.uniforms, shared);
    shader.defines = { ...(shader.defines ?? {}), ...defines };
    shader.vertexShader = GRADE_HEAD + VERTEX_HEAD + 'uniform float uYearT;\n' + CROP_GLSL + shader.vertexShader
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERTEX_OFFSET);
  };
  depth.customProgramCacheKey = () => `kitdepth:${variant}`;
  material.userData.kitKey = `kit:${variant}`;

  return { material, depth };
}

/**
 * High-only detail (docs/design/micro-detail.md): relief on roof courses
 * (micro) and specular on glass and wet roofs (specular). Off compiles
 * exactly the shader the kit had before.
 */
export function setKitDetail(material, { micro = false, specular = false } = {}) {
  material.defines ??= {};
  if (micro === Boolean(material.defines.MICRO_DETAIL) && specular === Boolean(material.defines.SPECULAR)) return;
  if (micro) material.defines.MICRO_DETAIL = 1;
  else delete material.defines.MICRO_DETAIL;
  if (specular) material.defines.SPECULAR = 1;
  else delete material.defines.SPECULAR;
  const key = material.userData.kitKey + (micro ? ':micro' : '') + (specular ? ':spec' : '');
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
}
