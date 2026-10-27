# Hearthvale — Visual, Rendering & UI Spec

Scope: art direction, water, lighting/shadows, scale plan, roads, building evolution, life, UI system, sound, module map. Written against Three.js r180, the current `src/world.js` setup, and the analytic terrain in `src/terrain.js` (`riverX(z) = 17 + sin(z/23)*7 + sin(z/51)*5`, `heightAt`, river bed at -0.8, banks ramp over 4.4–6 units, water surface at 0.025).

Hard targets (iPhone 15 Pro, Safari, "medium" tier): **≤ 8 ms GPU, ≤ 4 ms JS per frame at 60 Hz** with 3,000 buildings and 3,000 villagers in view range; **≤ 150 draw calls**; **≤ 1.2 M triangles on screen**; **≤ 1 shadow pass per 250 ms** in steady state. On M-series "high" tier: 120 Hz capable, but cap at 60 Hz unless the display is ProMotion and the tab is focused.

---

## 1. Art direction — "The Tabletop Chronicle"

**One sentence:** a hand-built model village on a wooden table, lit by a window, seen by someone leaning in. Low-poly, flat-shaded, slightly chunky proportions, soft directional sunlight, faint tilt-shift at the frame edges, no texture detail smaller than "a plank".

Rules that keep it cohesive across 150 years:

1. **Flat shading everywhere on architecture.** Every building face is one colour, lit once. No smooth normals on hard-surface meshes. Trees and villagers are also flat-shaded. Only water and sky are continuous gradients.
2. **Palette discipline: 3 hues per material family, ±8 % value jitter per instance.** Jitter comes from the instance id hash, never from random at runtime, so saves look identical on reload.
3. **Silhouette says era, colour says wealth, props say function.** A 1700s cottage and an 1850s terrace differ in roof pitch and height first, paint second.
4. **Nothing is pure.** No #FFFFFF, no #000000. Whites are `#f4efe4`; darks are `#2b2f2a` (warm) or `#26302e` (cool at night).
5. **Edges are soft, geometry is crisp.** Fog, tilt-shift blur, and vignette soften the frame; inside the frame everything is sharp flat faces.

### 1.1 Base palette (surface albedos, sRGB)

| Family | A | B | C | Notes |
|---|---|---|---|---|
| Grass low | `#8fb562` | `#9bbd6a` | `#86ab5c` | vertex colour, current look is right |
| Grass high / meadow | `#b3c76a` | `#bccf74` | | |
| Sand / dirt | `#d5c48f` | `#c9b580` | | |
| Water base | `#3f8a99` | tint by depth, see §2 | | |
| Timber | `#8c6a44` | `#7a5a3a` | `#a07b52` | |
| Thatch | `#c9a86a` | `#b89a5c` | | |
| Plaster/limewash | `#efe6cf` | `#e6dcc2` | `#f1ead8` | |
| Stone (grey) | `#9a9a90` | `#8b8c84` | `#a9a89c` | |
| Stone (honey) | `#c8b48a` | `#bba57c` | | regional variant chosen at world seed |
| Brick | `#a8553f` | `#9c4e3b` | `#b46450` | |
| Slate | `#5c6670` | `#525b64` | | |
| Clay tile | `#c3613f` | `#b5573a` | `#cf6d49` | current red roofs are close; desaturate 10 % |
| Stucco (era 5–6) | `#e9dfd0` | `#dcd2c3` | `#f0e8dc` | |
| Glass | `#9fc2c8` | emissive at night | | |
| Leaf (summer) | `#5f8c4a` | `#698c4c` | `#4e7e52` | |
| Pine | `#466f49` | `#3f6442` | | |

### 1.2 Season and time-of-day grading

Grading is **one shared uniform block** `uGrade` applied in every custom shader and via `onBeforeCompile` in the Three materials: `sunColor`, `skyColor`, `groundColor`, `fogColor`, `fogNear/Far`, `exposure`, `tint` (vec3 multiply on albedo), `snow` (0–1), `autumn` (0–1), `nightWindows` (0–1).

| | Sun colour | Hemi sky | Hemi ground | Fog | Albedo tint | Exposure |
|---|---|---|---|---|---|---|
| Spring noon | `#fff1d6` | `#dcefff` | `#6e7d4a` | `#c4d9cf` | `1.00,1.02,0.98` | 0.96 |
| Summer noon | `#fff6e0` | `#cfe8ff` | `#7a8248` | `#c9dccb` | `1.03,1.01,0.95` | 1.00 |
| Autumn noon | `#ffe3b8` | `#e3ecf4` | `#857646` | `#d8d2c0` | `1.06,0.98,0.88` | 0.94 |
| Winter noon | `#f2f0f4` | `#dde6ee` | `#9aa0a6` | `#dfe3e6` | `0.96,0.98,1.04` | 0.92 |
| Golden hour (any) | `#ffc98a` | `#ffd8c0` | `#6a5a3c` | `#e4c4a6` | `1.08,0.96,0.86` | 0.90 |
| Dusk | `#ff9e74` | `#8e8fb8` | `#4e4a44` | `#9c8fa8` | `0.92,0.86,0.96` | 0.80 |
| Night | `#8fa6d6` (moon, 0.35 intensity) | `#3a4668` | `#262a2e` | `#2e3744` | `0.70,0.76,0.92` | 0.70 |

Blend between keyframes by a smoothstep on `dayFraction`. Keep the day cycle **slow and optional**: one in-game "day" is 6 s; a visible day/night cycle at that rate is nauseating. Instead drive time of day from **season progress**: morning in early spring, noon in summer, golden in autumn, long dusk in winter, with a **true night only during the year-end "chronicle" beat** (≈ 6 s, lanterns on). Settings: "Day cycle: Seasonal (default) / Fast / Off".

### 1.3 Era materials

Eras are continuous (year 0–150) but materials come in six steps. A building's `style` is set when built or upgraded; neighbours bias toward each other's style (90 %) so streets look coherent.

| Era | Years | Walls | Roof | Roof pitch | Typical height | Details |
|---|---|---|---|---|---|---|
| 1 Hearth | 0–25 | timber frame + limewash, wattle | thatch (rounded ridge), wood shingle | 48° | 1 floor + loft | wells, fences, hay |
| 2 Stone | 25–50 | fieldstone, honey stone | clay tile, slate | 42° | 2 floors | chimneys, stone bridge |
| 3 Guild | 50–80 | brick, half-timber upper floors | slate | 38° | 2–3 floors | gables to street, signage, lamps |
| 4 Terrace | 80–110 | brick rows, rendered stucco | slate/tile, shared party walls | 34° | 3–4 floors | chimney rows, iron railings, gas lamps |
| 5 Civic | 110–135 | stucco, dressed stone, early concrete | low hip, flat with parapet | 15° | 4–6 floors | arcades, clock, trams later |
| 6 Glass | 135–150 | stucco + glass curtain wall accents, timber-clad modern | flat, green roof | 0–8° | 5–10 floors | balconies, solar, rooftop gardens |

Cohesion rule: later eras **add** materials but never remove earlier ones; a 150-year town has thatch in the old quarter. Glass is always framed by timber or stucco, never a full glass box — the table-model look must survive.

### 1.4 Camera & framing

Keep 40° FOV; add a **tilt-shift** only in a post-pass on high tier (see §3.6). Lower `maxPolarAngle` to `PI*.44` so the horizon never shows raw sky without the dome. Vignette is CSS (`radial-gradient` overlay on the canvas, `pointer-events:none`) so it costs zero GPU.

---

## 2. Water

### 2.1 Geometry — river ribbon from the centreline

Replace the flat strip with a **ribbon mesh** generated from `riverX(z)`:

```js
// src/render/water.js
export function buildRiverRibbon({zMin, zMax, step = 2, halfWidth = 6.0, lanes = 8}) {
  const rows = Math.floor((zMax - zMin) / step) + 1;
  const pos = new Float32Array(rows * (lanes + 1) * 3);
  const uv  = new Float32Array(rows * (lanes + 1) * 2);   // u = across (0..1), v = along (metres)
  const depth = new Float32Array(rows * (lanes + 1));      // bed depth under this vertex
  const idx = [];
  for (let r = 0; r < rows; r++) {
    const z = zMin + r * step;
    const cx = riverX(z);
    const dx = (riverX(z + 0.5) - riverX(z - 0.5));         // tangent x
    const len = Math.hypot(dx, 1); const nx = 1 / len, nz = -dx / len; // normal across flow
    for (let l = 0; l <= lanes; l++) {
      const t = l / lanes, a = (t - 0.5) * 2;                 // -1..1 across
      const w = halfWidth * (1 + 0.06 * Math.sin(z / 9));     // slight width wobble
      const x = cx + nx * a * w, zz = z + nz * a * w;
      const i = r * (lanes + 1) + l;
      pos[i*3] = x; pos[i*3+1] = 0.025; pos[i*3+2] = zz;
      uv[i*2] = t; uv[i*2+1] = z;
      depth[i] = 0.025 - heightAt(x, zz);                     // 0 at bank, ~0.83 mid
      if (r && l) { const p = i - (lanes + 1); idx.push(p-1, i-1, i, p-1, i, p); }
    }
  }
  // overshoot: extend halfWidth to 6.4 so the last lane sits under the bank, hiding the seam.
}
```

Use `halfWidth = 6.4` (bank geometry ends at 6.0) so water tucks *under* the terrain; terrain draws first with depth so the overlap is hidden. Outer two lanes get `aDepth ≈ 0`, which drives foam and transparency, so no visible hard edge. Lakes later: same builder over a closed loop of a shoreline polyline with a fan centre; canals: straight ribbons from the road planner with `halfWidth = 2`.

Set `material.side = FrontSide`, `depthWrite = false`, `transparent = true`, render order after opaque, before particles. Water does **not** cast shadows; it **does** receive (cheap, PCF sample already in the shader if `receiveShadow` is left on; on low tier disable).

### 2.2 Shader — one `ShaderMaterial`, no textures required

Inputs: `uTime`, `uSunDir`, `uSunColor`, `uSkyZenith`, `uSkyHorizon`, `uCamPos`, `uFlowDir` (per-vertex tangent, passed as attribute), `uShadowStrength`, optional `tReflect` (planar), `tNormals` (64×64 generated `DataTexture`, RG = packed normal of summed sines, RGBA8, repeat, `LinearMipmapLinear`).

Generate the normal tile once at load (CPU, 64×64, ~4k evaluations) from 5 summed gradient-noise octaves with tileable phases. This beats evaluating noise per-pixel on phone GPUs. Two lookups, scrolled at different speeds and angles along the flow tangent:

```glsl
// vertex
attribute float aDepth; attribute vec2 aFlow;
varying vec3 vWorld; varying float vDepth; varying vec2 vUv; varying vec2 vFlow;
void main(){
  vec3 p = position;
  // two low-frequency sine ripples, tiny amplitude, only for silhouette at banks
  p.y += 0.012 * sin(p.x*1.7 + uTime*1.3) * sin(p.z*1.1 + uTime*0.9) * smoothstep(0.0,0.25,aDepth);
  vec4 w = modelMatrix * vec4(p,1.0); vWorld = w.xyz; vDepth = aDepth; vUv = uv; vFlow = aFlow;
  gl_Position = projectionMatrix * viewMatrix * w;
}
```

```glsl
// fragment (medium tier). precision mediump float on mobile.
uniform sampler2D tNormals; uniform float uTime; uniform vec3 uSunDir, uSunColor, uSkyZenith, uSkyHorizon, uCamPos;
uniform float uFoam, uReflectMix; uniform sampler2D tReflect; uniform vec2 uViewport;
varying vec3 vWorld; varying float vDepth; varying vec2 vUv; varying vec2 vFlow;

vec3 unpackN(vec2 rg){ vec2 n = rg*2.0-1.0; return normalize(vec3(n.x, 1.0, n.y)); }

void main(){
  // flow-aligned scrolling: along-river coordinate is vUv.y (metres); across is vUv.x*12
  vec2 base = vec2(vUv.x*12.0, vUv.y);
  vec3 n1 = unpackN(texture2D(tNormals, (base + vec2(0.0, -uTime*0.55)) * 0.11).rg);
  vec3 n2 = unpackN(texture2D(tNormals, (base*0.63 + vec2(0.7, -uTime*0.31) + vec2(uTime*0.03,0.0)) * 0.21).rg);
  vec3 n = normalize(vec3(n1.xz + n2.xz, 2.6).xzy);            // flatten: strength 1/2.6
  n = normalize(mix(vec3(0,1,0), n, smoothstep(0.0, 0.35, vDepth))); // calm at banks

  vec3 V = normalize(uCamPos - vWorld);
  float NoV = max(dot(n, V), 0.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);

  // sky reflection: analytic gradient by reflected ray elevation
  vec3 R = reflect(-V, n);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, clamp(R.y*1.6, 0.0, 1.0));

  // sun specular, Blinn-Phong with two lobes (broad + sharp) looks like real glitter on low-poly
  vec3 H = normalize(uSunDir + V);
  float NoH = max(dot(n, H), 0.0);
  float spec = pow(NoH, 160.0) * 1.4 + pow(NoH, 24.0) * 0.12;

  // depth tint: bed colour fades to deep colour, analytic depth, no prepass
  vec3 shallow = vec3(0.56, 0.72, 0.66); vec3 deep = vec3(0.16, 0.42, 0.50);
  vec3 body = mix(shallow, deep, smoothstep(0.0, 0.7, vDepth));
  float alpha = mix(0.25, 0.92, smoothstep(0.0, 0.45, vDepth));

  // shoreline foam: thin band at depth≈0.08, broken by n1 noise and animated along flow
  float foamBand = 1.0 - smoothstep(0.02, 0.16, abs(vDepth - 0.07));
  float foamNoise = texture2D(tNormals, (base*0.9 + vec2(0.0,-uTime*0.8))*0.07).b; // blue = scalar noise
  float foam = foamBand * smoothstep(0.45, 0.7, foamNoise) * uFoam;

  vec3 reflCol = sky;
  #ifdef PLANAR
    vec2 suv = gl_FragCoord.xy / uViewport; suv.x = 1.0 - suv.x;        // mirrored
    vec3 planar = texture2D(tReflect, suv + n.xz * 0.045).rgb;
    reflCol = mix(sky, planar, uReflectMix);
  #endif

  vec3 col = mix(body, reflCol, fresnel * 0.85) + uSunColor * spec;
  col = mix(col, vec3(0.93, 0.95, 0.9), foam);
  gl_FragColor = vec4(col, max(alpha, foam));
  #include <fog_fragment>   // reuse Three fog chunk; define fogDepth in vertex
}
```

Shadow receive: on medium/high tier include Three's `shadowmap_pars_fragment` and multiply `body` by `getShadow(...)` (one directional light). On low tier skip.

### 2.3 Quality tiers for water

| Tier | Normals | Foam | Shadow on water | Planar reflection |
|---|---|---|---|---|
| Low (older phones, frame > 20 ms) | 1 lookup | off | off | off (sky gradient only) |
| Medium (iPhone 15 Pro default) | 2 lookups | on | on | off |
| High (M-series default) | 2 lookups | on | on | **on**: 1/4 res RT (e.g. 480×300), updated every 2nd frame, buildings + terrain + trees only (layer mask `REFLECT`), no people, no shadows, no fog pass; `uReflectMix = 0.6` |

Planar reflection is a mirrored camera (`THREE.Reflector`-style math, but write your own: 40 lines) with an oblique near plane at y = 0.025. Because the river is a single plane this is exact. Reflection camera uses the **LOD-far** building batches only (see §4), so the cost is ≈ 25 draw calls at quarter res, ~0.8 ms on M1.

### 2.4 Flow and boats

`aFlow` tangent is used for scrolling and later for boats: a boat is an instanced prop whose position advances along `z` at `0.9 m/s` with `x = riverX(z)`, yaw from tangent, plus a 0.02 bob from the same sine as the vertex shader so hulls sit in the ripples. A small wake quad trailing behind, alpha-scrolled from `tNormals.b`.

---

## 3. Shadows & lighting

### 3.1 Fix list (do these first, in order)

1. **Flat normals on all building/prop geometry.** After building each procedural piece: `geo = geo.toNonIndexed(); geo.computeVertexNormals();`. Non-indexed + `computeVertexNormals` gives per-face normals. Do this *before* merging. Merged batch stays non-indexed. Memory cost: +~2.2× vertices, fine (a cottage is ~300 tris). This removes the smooth-gradient and dark eave/ridge seams.
2. **Shadow camera follows the view target.** Each time `controls.target` moves > 1 unit or zoom changes > 10 %:
   ```js
   const r = THREE.MathUtils.clamp(controls.getDistance() * 0.9, 45, 160);
   const texel = (2 * r) / shadow.mapSize.width;
   // snap target to texel grid in light space to kill shimmer
   const t = controls.target.clone();
   lightSpace.copy(sun.shadow.camera.matrixWorldInverse); // light view
   const lt = t.applyMatrix4(lightSpace);
   lt.x = Math.round(lt.x / texel) * texel; lt.y = Math.round(lt.y / texel) * texel;
   t.copy(lt).applyMatrix4(sun.shadow.camera.matrixWorld);
   sun.target.position.copy(t); sun.position.copy(t).addScaledVector(sunDir, 180);
   Object.assign(sun.shadow.camera, {left:-r, right:r, top:r, bottom:-r, near:20, far:360});
   sun.shadow.camera.updateProjectionMatrix(); sun.shadow.needsUpdate = true;
   ```
3. **Bias:** `bias = -0.0006`, `normalBias = 0.02 * (r / 90)` (scale with frustum so it stays ≈ 1 texel). The current 0.045 normalBias detaches thin objects (fence posts float). Use `PCFSoftShadowMap` on high, `PCFShadowMap` on medium, `BasicShadowMap` + 1024 on low.
4. **Map size:** high 2048, medium 2048, low 1024. One cascade only; the far field beyond `r` gets **no dynamic shadow** but keeps baked contact AO (§3.3), which reads fine at that distance.
5. **Cast/receive rules.** Cast: buildings, trees (trunk + canopy), bridges, walls, people (medium/high only, via the LOD silhouette mesh, not the 8 part batches), boats. Do not cast: water, smoke, birds, glints, crop rows, ground decals, thin planes (banners, awning cloth, signs — model them as 0.05-thick boxes if a shadow matters), open cones (fountain spray). Receive: terrain, water (medium+), building batches, roads (via terrain). People do not receive.
6. **Animated casters.** Windmill rotor, boats, people: either cast with a per-frame shadow update (high tier only, and only while within 60 units of the target) or **do not cast**, and use a contact blob instead. Default: rotor does not cast; a static blurred rotor disc decal is placed on the ground, which looks like a slowly turning mill from the game's camera distance. People cast only on high.
7. **Refresh cadence.** `shadowMap.autoUpdate = false`. Set `needsUpdate = true` when: a batch is rebuilt, the target/zoom moved (snapped), season changes sun elevation, or a construction tick completes. Additionally, at most **4 Hz while anything is animating in the shadow frustum on high tier**. Never per-frame on mobile.
8. **Sun direction by season:** elevation 62° summer, 48° spring/autumn, 30° winter; azimuth fixed at 215° so shadows fall toward the camera's default side and never flip. Dusk/night: elevation 12°, then moon from the opposite azimuth at 0.35 intensity.

### 3.2 Lighting rig

- `HemisphereLight(sky, ground, 1.4)` — the sky/ground pair comes from `uGrade`.
- `DirectionalLight(sun, 2.8)` with shadow as above.
- **No environment map** (keep: saves bandwidth; flat shading doesn't need it). `MeshLambertMaterial` for everything opaque; `MeshStandardMaterial` only for glass/water/metal. Lambert is ~35 % cheaper per pixel on Apple GPUs than Standard, and the look wants it.
- ACES tone mapping stays, exposure from `uGrade`.

### 3.3 AO substitutes (no SSAO)

1. **Baked vertex AO in building kits.** For each kit piece, at generation time, compute per-vertex AO by 8 short rays (0.6 units) against the piece's own AABB set (walls under eaves, between extensions, inside doorways). Store as a float attribute `aAO` (0.55–1.0). Multiply in the fragment via `onBeforeCompile` (`diffuseColor.rgb *= vAO`). Cost: 0.
2. **Ground contact decal.** One instanced quad per building and tree, 1.3× the footprint, with a radial soft alpha from a 32×32 generated texture; `depthWrite=false`, `polygonOffset` on, draws after terrain. Colour = ground colour × 0.55. One `InstancedMesh` per chunk (so it shares culling with the chunk). This is what sells "sitting on the table".
3. **Terrain vertex AO near buildings** is not needed if (2) exists.
4. **Fake sky occlusion on walls:** mix wall colour toward `0.92×` over the lower 20 % of height (`aAO` already does this for walls; extend to a vertical gradient term in the vertex shader: `vAO *= 0.9 + 0.1*smoothstep(0,1.5,localY)`).

### 3.4 Sky dome

A 24-segment inverted sphere (radius 700, `depthWrite=false`, drawn first, `frustumCulled=false`, follows the camera) with a 3-stop gradient shader: `horizon → mid → zenith` from `uGrade`, plus a sun disc `pow(dot(dir,sunDir),600)` and a soft halo `pow(..., 8) * 0.15`. Night: add 150 stars as a static `Points` on the same dome, alpha from `uGrade.night`. Clouds: 12 flat low-poly cloud meshes (merged, one draw) at y = 60, scrolling 0.3 m/s, casting **no** shadow, opacity 0.85, with a cheap "cloud shadow" done as a scrolling multiplier in the terrain shader (`1 - 0.12*noise(worldXZ*0.02 + time*0.01)`), high tier only.

### 3.5 Seasons at shader level

- **Snow:** uniform `uSnow` (0–1). Terrain: `albedo = mix(albedo, #eef0f2, smoothstep(0.3,0.8,uSnow) * smoothstep(0.55,0.9,normal.y))`. Roofs: same rule with `aRoof` attribute = 1 for roof faces (kit pieces tag roof vertices) so snow sits on roofs but not walls. Trees: leaf canopies get snow caps via `normal.y`; pine stays. Water: `uFoam` drops, banks get ice rim (`vDepth<0.05 → mix toward #dfe8ea`).
- **Autumn:** trees are instanced; set per-instance colour (`setColorAt`) from a deciduous palette `#c7913b / #b8622e / #d9b24a / #9a7a2d` with a per-tree phase so the turn spreads over 3 weeks of game time. Winter: deciduous canopies scale to 0.35 on y and colour `#6b5a44` (bare look without new geometry). Leaf fall particles per §7.
- **Spring:** fruit tree variant gets `#f1d6dc` blossom tint for 2 weeks; grass tint shifts toward `#a4c86b`.
- Crops: per-instance colour across the growing season green→gold→stubble; harvest sets scale y 0.25.

### 3.6 Fog and post

`Fog(fogColor, 150, 420)` from `uGrade`; sky dome ignores fog. Post-processing: **none on low/medium**. On high: one full-screen pass combining FXAA-free (MSAA already on), tilt-shift (vertical gaussian 9-tap, strength ramps from 0 at 35 % screen height to 1 at the edges, `maxBlur = 2.5 px`), and a 2 % film-grain dither to stop gradient banding on sky/water. ~0.6 ms on M1 at 1.75 dpr.

---

## 4. Scale & performance plan

### 4.1 Buildings: parametric kit, instanced, never merged uniquely

Stop generating unique geometry per building and merging. Instead:

**Kit pieces** (each a non-indexed `BufferGeometry` with `aAO`, `aRoof`, `aPart` attributes), built once at load, per era style:

- `body_box` (walls, unit cube scaled by w×h×d)
- `roof_gable`, `roof_hip`, `roof_flat_parapet`, `roof_thatch` (unit footprint, pitch baked per style; scaled in x/z, height via instance `uRoofH`)
- `chimney`, `dormer`, `porch`, `awning`, `sign`, `extension_box`, `stairs`, `balcony_row`, `window_strip` (a strip of n windows as a thin box with per-instance count via UV scale), `door`
- `scaffold` (construction), `crane` (era 5+)

A **lot** is rendered as **3–7 instances** across kit pieces. All instances of one piece share one `InstancedMesh` **per 100-unit region** (so chunk culling works). Per-instance attributes (InstancedBufferAttribute, interleaved where possible):

```
iMatrix      (mat4, built-in instanceMatrix)   position/rot/scale (w,h,d)
iColor       (vec3)  wall colour  (built-in instanceColor)
iColor2      (vec3)  roof/trim colour
iParams      (vec4)  [wear 0-1, lit-window strength 0-1, age-darkening 0-1, snowMask]
iWindows     (vec2)  [cols, rows]  for the window strip UV tiling
```

Shader (`onBeforeCompile` on Lambert): `diffuseColor.rgb = mix(iColor, iColor2, aPart) * (1 - 0.18*iParams.z) * vAO;` plus window emissive at night: `emissive += vec3(1.0,0.78,0.45) * iParams.y * uGrade.nightWindows * windowMask(uv, iWindows)`, where `windowMask` is an analytic grid of rounded rects (`fract(uv*iWindows)` with a smoothstep box) — no texture.

Count: 6 eras × ~12 pieces ≈ 72 geometries, but at most ~40 pieces are present in any one region. Draw calls per region: number of pieces present (≤ 40). With 9 regions in frustum that's too many → **merge piece instancing across regions into one `InstancedMesh` per piece per LOD ring**, and cull by writing `instanceCount` after a CPU sort by region (cheap: regions are coarse, sort only when the camera crosses a region boundary). Target: **≤ 45 draw calls for all buildings**.

**Incremental updates:** each lot owns a slot list `[ {piece, index} ]`. Changing a lot writes only those matrices/colours and sets `instanceMatrix.addUpdateRange(index*16, 16)` + `needsUpdate` (Three r180 supports partial upload via `updateRanges`). A new lot appends to free slots (keep a free-list; capacity grows by 1.5× with a rebuild only when exhausted). **No full rebuild on change.** Demolition: scale the matrix to 0 and push the slot to the free list.

### 4.2 Building LOD

| Ring | Distance from camera | What draws |
|---|---|---|
| L0 | < 90 | full kit (3–7 pieces per lot), contact decals, props |
| L1 | 90–220 | `body_box` + roof piece only (2 instances), no props, no window emissive grid (replace by a uniform tint of iParams.y) |
| L2 | > 220 | one `block_lod` piece: a single box with roof colour on the top face via `aPart`; 12 tris |

Rings are recomputed when the camera target moves > 15 units; each lot's pieces are moved between the three per-piece instanced meshes by swapping slots. For 3,000 lots at L0+L1+L2 total triangles ≈ 3000×(avg 180) ≈ 0.55 M. Fine.

### 4.3 Terrain

Keep 100-unit chunks but drop vertex density to 64×64 beyond 200 units (a second geometry sharing the same shader). Terrain shader gets: vertex colour, road splat (§5), cloud shadow, snow, contact decals are separate. Chunks are frustum-culled by Three. Chunks outside 500 units are not created.

### 4.4 Trees

Keep 3 `InstancedMesh` per chunk → change to **3 per LOD ring across the world** (trunk+canopy L0 ≈ 60 tris; L1 billboard-less "canopy blob" 12 tris). Per-instance colour for season. Tree removal (clearing for lots) scales the matrix to 0 over 0.6 s (cheap "chopping" animation: shrink y, tilt 12°), then frees the slot.

### 4.5 People: one instanced mesh, vertex-shader animation

Replace the 8 part batches + per-frame matrix upload with **one `InstancedMesh`** of a 44-tri villager (head, torso, two arms, two legs as separate rigid boxes, each vertex tagged `aBone` ∈ {0..5}) and a **per-instance state buffer** updated only when the sim changes it:

```
iPos        vec3  world position at time t0
iVel        vec3  velocity (units/s) — shader extrapolates: pos = iPos + iVel * (uTime - iT0)
iT0         float
iAnim       vec4  [gait phase offset, speed (0 idle, 1 walk), action id, action start time]
iLook       vec4  [skin, cloth hue, hat id, scale]  (colours chosen in shader from a 16-entry palette uniform)
```

Vertex shader: `walk = sin((uTime*6.0*speed) + phase)`; legs rotate ±0.5 rad by `aBone`, arms counter-phase, torso bobs 0.03. Actions (id): 1 = carry (arms forward), 2 = build (hammer: arm raised, 2 Hz), 3 = sit, 4 = cheer (both arms up, bounce), 5 = protest (one arm up with sign scale > 0), 6 = dance. Facing = `atan(iVel.x, iVel.z)` or last facing stored in `iAnim.w` when idle.

CPU per frame: **zero** in steady state. The sim thread writes to a shared `Float32Array` (one row per person, 16 floats); when the sim updates a person's route (a few hundred per second at most), mark a dirty range and upload only that range once per frame via `addUpdateRange`. Even a full 3,000 × 64 B = 192 KB upload is ~0.1 ms, so worst case is fine.

LOD: beyond 120 units, draw the same mesh with `uLod = 1` which collapses arms/legs into the torso (vertex shader `if (aBone > 1) position = torsoPos`), keeping one draw call. Beyond 260 units, villagers are not drawn (the crowd is implied by window light and smoke).

Shadows for people: the single mesh can cast on high tier (one extra draw into the shadow map); off on medium/low.

### 4.6 Culling and per-frame CPU

- Chunk-level frustum culling is Three's default; **set `frustumCulled = false` on global instanced meshes** and do your own `instanceCount` trimming by region sort (buildings) or a coarse grid (people: sort rows by region every 500 ms, trimmed by camera visibility).
- `renderer.info.render.calls` must be printed in the debug overlay; keep ≤ 150.
- Avoid `Object3D` per building/person entirely. Lots and people are rows in typed arrays.
- No `Vector3` allocations in the frame loop; pre-allocate scratch.

### 4.7 Quality tiers

| | Low | Medium | High |
|---|---|---|---|
| Auto-select | median frame > 18 ms over 3 s at Medium, or `maxTextureSize` < 8192 | default on iOS/Android | default on desktop with ≥ 4 GPU cores reported or UA mac/win |
| Pixel ratio | min(dpr, 1.25) | min(dpr, 1.75) | min(dpr, 2) |
| AA | none | MSAA 4× (WebGL2 default antialias) | MSAA 4× + post pass |
| Shadow map | 1024, Basic | 2048, PCF | 2048, PCFSoft |
| People cast | no | no | yes |
| Water | tier Low | Medium | High (planar) |
| Clouds shadow / grain / tilt-shift | no | no | yes |
| Particles | 25 % | 60 % | 100 % |
| Contact decals | yes | yes | yes |

Auto-detection: start at Medium, measure the rolling median of `requestAnimationFrame` deltas while rendering a fixed camera for 3 s after load; drop to Low if > 18 ms, raise to High if < 9 ms and desktop. Re-evaluate after any big population jump (era change). Persist to `localStorage`, user override in Settings.

### 4.8 Battery and frame pacing

Code: `src/render/pacing.js` (pure rules, tested in `tests/render-pacing.test.js`), applied by `wantFrame` / `frameDue` in `src/render/index.js` and the loop in `src/main.js`.

- **One decision per animation frame.** The loop asks `world.frameDue(time, dt)` first (it runs the camera and decides). On frames that won't draw, it skips the sim step and view sync; the real seconds owed (at most 0.25 s) go to the sim on the next drawn frame. The sim's fixed 0.1 s tick makes the outcome the same, and walkers need no interpolation: each row carries `t0`, velocity and its waypoint arrival time, so `rowDt` places every walker at the drawn frame's own time. `app.update` still runs every frame (it throttles itself).
- **Caps land on whole refreshes.** The refresh rate is measured from frame deltas (median of 90, snapped to 60/90/120/144…). A cap draws every n-th refresh, n = ⌈refresh / fps⌉, with the threshold half a refresh early so timestamp jitter never slips a frame: 30 fps is every 2nd refresh at 60 Hz, every 4th at 120 Hz, every 3rd at 90 Hz. Caps that aren't whole refreshes (45 on 60 Hz) judder, so none are offered.
- **Full rate** (`tier.maxFps`, 60) whenever the sim runs, with no idle cap. Input, camera tweens and follow always draw.
- **Paused** with no input for 2 s: once a second, for the ambient smoke.
- **Tab hidden:** the browser stops animation frames, so the town pauses, audio suspends and the game saves. **Window visible but unfocused:** no change (watching on a second screen is real use).
- **Battery saver** (Settings → Display: Off / On battery / Always; default Off). While saving: 30 fps when you're watching, back to full rate while you move the view and for 1 s after; pixel ratio at most 1.25 (half a phone's pixel work at 3× density on Medium); in Auto detail, one tier lower (High → Medium drops the reflection, post pass and soft shadows), and the auto tuner waits. A manual Detail choice is kept apart from the pixel cap. 'On battery' needs the Battery API (Chrome and Edge). Safari and Firefox report nothing, so there it never engages and the Settings hint says to choose Always. iOS Low Power Mode already holds Safari to 30 Hz; the meter then measures 30 Hz and draws every frame.
- **Low battery** (unplugged below 20 %, where it can be read) always saves, even with the setting Off, and forces Low in Auto detail. When saving starts by itself (On battery, or low battery), a quiet toast says so; choosing Always shows none.
- Never run above 60 Hz unless the user sets "Smooth (120 Hz)" in Settings (not built yet).

---

## 5. Emergent roads — splat texture sampled by the terrain shader

### 5.1 Data contract

From the sim: `wear` is a `Float32Array(W*H)` grid, `cell = 1.0` unit (1 m) initially; origin `(ox, oz)`; values 0..1 = cumulative normalised traffic with decay. The sim also provides `roadTier` (`Uint8Array`, 0 none / 1 trail / 2 track / 3 road / 4 cobbled / 5 paved), which is derived from wear plus council decisions (paving is a decision; it sets tier 4/5 on cells regardless of wear). Both arrays are **double-buffered**; the sim marks a dirty rect per tick.

### 5.2 Texture

One `DataTexture` `tRoad`, RGBA8, size = grid size (e.g. 512×512 covering 512×512 m; at 1 m/cell that's 1 MB, fine). Channels: **R = wear (0–255)**, **G = tier (0–5 × 51)**, **B = edge noise phase**, **A = age** since tier change (for the "new pavement is lighter" cue). Upload dirty rects only, via `gl.texSubImage2D`: in Three r180 use `renderer.copyTextureToTexture(srcDataTexture, tRoad, srcRegion, dstPosition)` with a small scratch `DataTexture` the size of the dirty rect — or simpler, keep one full-size `DataTexture` and set `needsUpdate` at most **2 Hz** (a 1 MB upload is ~0.3 ms; acceptable). Start with the simple path.

### 5.3 Terrain shader

```glsl
uniform sampler2D tRoad; uniform vec2 uRoadOrigin; uniform float uRoadInvSize; // 1/metres covered
varying vec3 vWorld; varying vec3 vColor;

vec3 roadColor(float tier, float wear, float age, vec3 grass, vec2 wuv){
  // tier look table
  vec3 trail  = mix(grass, vec3(0.70,0.64,0.44), 0.55);           // flattened grass
  vec3 track  = vec3(0.62,0.53,0.38);                              // dirt with ruts
  vec3 road   = vec3(0.67,0.60,0.47);                              // packed gravel
  vec3 cobble = vec3(0.56,0.56,0.54);
  vec3 paved  = vec3(0.47,0.47,0.49);
  vec3 c = trail;
  c = mix(c, track,  smoothstep(1.5, 2.0, tier));
  c = mix(c, road,   smoothstep(2.5, 3.0, tier));
  c = mix(c, cobble, smoothstep(3.5, 4.0, tier));
  c = mix(c, paved,  smoothstep(4.5, 5.0, tier));
  // texture hints without textures: ruts along flow (track), cobble dither, paved centre line
  float ruts = sin(wuv.x*18.0)*sin(wuv.y*18.0);
  c *= 1.0 + 0.04*ruts*step(1.5,tier)*(1.0-step(3.5,tier));
  float cob = step(0.5, fract(wuv.x*2.0)) == step(0.5, fract(wuv.y*2.0)) ? 0.03 : -0.03;
  c *= 1.0 + cob*step(3.5,tier)*(1.0-step(4.5,tier));
  c = mix(c, c*1.08, (1.0-age)*0.5);                                // fresh surface is lighter
  return c;
}

void main(){
  vec2 ruv = (vWorld.xz - uRoadOrigin) * uRoadInvSize;
  vec4 r = texture2D(tRoad, ruv);                                   // bilinear = soft edges for free
  float wear = r.r, tier = r.g*5.0, noise = r.b, age = r.a;
  // organic edge: threshold wear with per-cell noise so edges are ragged, not blurry
  float cover = smoothstep(0.18 + noise*0.12, 0.45 + noise*0.12, wear);
  cover = max(cover, step(3.5, tier));                              // built roads are solid
  vec3 col = mix(vColor, roadColor(tier, wear, age, vColor, vWorld.xz), cover);
  // worn verge: darker grass around any road
  col *= 1.0 - 0.08 * smoothstep(0.05, 0.18, wear) * (1.0 - cover);
  ...
}
```

Sample `tRoad` with `LinearFilter`, no mipmaps (`generateMipmaps=false`), so each cell blends into neighbours; ragged edges come from the noise channel, not from resolution. On high tier add a second sample at 2× frequency of the *same* texture offset by half a cell to break the grid.

Why not ribbons: ribbons need polylines, which fight the emergent, blobby wear field and need re-triangulation on every change. The splat is one upload and reads perfectly as desire paths widening into roads. Ribbons return only for **bridges** (geometry from the kit: `bridge_timber`, `bridge_stone`, `bridge_iron`, spanning the ribbon across the river with abutments at `riverX(z) ± 6.4`) and later **tram rails** (thin instanced strips snapped to the splat's paved centreline).

Kerbs and pavements for tier 5: the shader draws a 0.6 m lighter band where `cover` crosses 0.5 (`abs(cover-0.5)<0.1`). Lamps (era 3+) are props placed by the sim on tier ≥ 4 cells at 12 m spacing, rendered as instanced `lamp` pieces with emissive at night.

---

## 6. Building evolution visuals

A lot's visual state is a function of `{type, tier, style, wealth, age, built, w, d, floors, extensions[], flags}`. The renderer composes kit pieces:

| Trigger (from sim) | Visual change |
|---|---|
| New lot | ground is cleared (trees in footprint ×1.3 get the chop animation), contact decal appears, **scaffold** piece appears at footprint height 0.4, then the body rises |
| Construction progress 0→1 | `body_box` scale.y = progress × floors × 3.2; roof appears at 0.85; scaffold piece height tracks body + 1; three builders assigned with `action=build`; dust puffs (particle) at 2 Hz at the top edge |
| Completed | scaffold scales to 0 over 0.5 s; body does a **1.04 → 1.00 overshoot "settle"** (`easeOutBack`, 400 ms) |
| Upgrade in place (tier +1) | scaffold returns for the duration; roof swaps to the new style piece; floors +1 grows from the existing height (scale.y tween 1.2 s); chimney count = floors−1 |
| Extension | new `extension_box` instance beside the body, shares wall colour, lower roof; max 2 per lot |
| Wealth ↑ (0..1) | wall colour moves toward the family's "A" colour (cleaner), trim colour saturates, window count +1 per 0.3 wealth, `sign`/`awning` for shops at wealth > 0.4, garden decal (flower dither) at wealth > 0.6 for homes |
| Wealth ↓ | `iParams.x` wear → desaturate 15 %, slight darkening; at < 0.15 shutters closed (window emissive off), roof colour patchy via `aRoof` noise |
| Age ↑ | `iParams.z` darkening up to 0.18; lichen tint on stone (slight green) past 40 years; after 80 years, 5 % chance of becoming a "heritage" building with warm highlight that resists demolition |
| Demolition / replacement | body scale.y → 0 over 0.8 s with a dust puff; replaced by the next era's lot |
| Parks | footprint decal in `#9bc06b` with path dither, 2–6 instanced trees, 1–3 benches, fountain piece for civic parks; era 4+ bandstand |
| Farms | crop rows as now (instanced) with seasonal colour; barn is a kit lot; orchard variant uses fruit trees |
| Replanting | trees placed by policy appear at scale 0.2 and grow to 1.0 over 3 game years |

Era-wide transitions (e.g. thatch → tile when the council rules) must **not** retint everything at once: schedule the re-roofing over 2–4 game years with per-lot jitter, each with a short scaffold. The town visibly "catches up" with a decision — that's the feedback the game is about.

---

## 7. Life and eye candy (all cheap)

- **Crowds at events.** The sim provides `events[]` with `{kind, x, z, radius, strength, t0, t1}`. The renderer does not move villagers (the sim does); it adds **ambient extras**: for `market`, 4–10 `stall` pieces (instanced, awning colour per stall from a 6-colour palette); for `festival`, banner strings (one instanced `bunting` segment piece between two poles, 12 flags each, vertex-wobbled in shader), lanterns on poles; for `protest`, villagers get `action=5` with `sign` colour per faction, a slow pulse of the event radius ring on the ground (decal); for `funeral`/`wedding`, villagers in a ring with `action=3`.
- **Smoke.** Keep the existing approach but instance it: one `Points`/quad `InstancedMesh` of 1 puff per chimney (max 600), vertex shader animates rise + spread + fade by `(uTime - iStart) mod 6 s`. Density scales with season (winter 2×) and time of day.
- **Birds.** 3 flocks of 9 as now; add a river-following heron (1 instance, slow). Keep `frustumCulled=false`.
- **Boats.** Era 2+: punts; era 4+: barges with cargo boxes; §2.4.
- **Night.** `nightWindows` ramps 0→1 over dusk; window emissive is per-instance (`iParams.y`) so empty homes stay dark and shops close after 20:00 game time; street lamps emissive + a small additive glow sprite (instanced, `depthWrite=false`), max 300 on screen.
- **Seasonal particles.** One `InstancedMesh` of 1,500 quads (medium: 900, low: 375). Vertex shader selects behaviour by `uSeason`: autumn leaves (spin, drift with the wind uniform, colour from palette), winter snow (slow fall, slight sway), spring pollen/blossom (tiny, bright, upward drift), summer: fireflies at night (0.5 % of quads, emissive). All spawn in a 160×160 box around the camera target and wrap.
- **Weather.** Rain: same particle system in a "streak" mode (stretched quad, 2× fall speed), with a `uWet` uniform that darkens roads 20 % and raises water specular. Rain probability is a sim weather output; the renderer only animates.
- **Wind.** Global `uWind` (vec2). Tree canopies sway (`sin(uTime*1.2 + worldX*0.1) * 0.02 * windStrength` vertex offset above y > 1.5); bunting and smoke share it; windmill rotor speed follows it.
- **Fountains.** Keep; cone does not cast; add 30 sprite droplets on high.
- **Construction dust / demolition puff.** Reuse smoke instances with a colour override.

Budget: everything in §7 together should be ≤ 12 draw calls.

---

## 8. UI design system — "The Ledger"

The UI is a set of paper sheets laid over the table. It starts as **one sheet** (the Council docket) and grows into a **binder** with tabs as institutions are founded. Everything is `position:fixed` layers over the canvas; no layout grid steals pixels from the scene.

### 8.1 Layout regions

Desktop (≥ 1000 px):

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ◉ hearthvale   Year 12 · Spring         [pop 28] [¤14,200] [78%] [210]   ⚙  │  top bar, 56px, translucent paper
├────┬─────────────────────────────────────────────────────┬───────────────────┤
│ ⌂  │                                                     │ ▌Council ▌Farms ▌…│  binder tabs (grow over time)
│ ▦  │                                                     │ ─────────────────│
│ ☼  │                  3D scene                           │  DOCKET  (3)     │
│ ⓘ  │                                                     │  ┌─────────────┐ │
│    │                                                     │  │ proposal card│ │  right rail, 380–440px
│    │   ┌──────────────┐                                  │  │ options...   │ │
│    │   │ chronicle    │ ← toasts/feed, bottom-left       │  └─────────────┘ │
│    │   │ last 3 lines │                                  │  ┌─────────────┐ │
│    │   └──────────────┘                                  │  │ next card    │ │
├────┴───────────────┬─────────────────────────────────────┴───────────────────┤
│ ⏸ 1× 3× 8×  ▓▓▓▓▓░ │  Year 12 → Era II "Stone" in 13 yrs      ◔ 🔈         │  time strip, 44px
└────────────────────┴─────────────────────────────────────────────────────────┘
```

Phone (< 720 px):

```
┌─────────────────────────┐
│ hearthvale  28 · ¤14k ⚙ │  top bar 48px + safe-area-top
│                         │
│       3D scene          │
│                         │
│  ⌂ ▦ ☼  (left rail,     │  three 44px buttons, left thumb
│          44px)          │
│                         │
│                         │
│ ╭───── ═══ ─────╮       │  bottom sheet, grab handle
│ │ ▌Council(3) ▌Farms │  │  snap 1: 88px peek — tab strip + time controls
│ │ ⏸ 1× 3×   Yr 12 Spr │  │
│ ├───────────────────────┤
│ │ Room to put down roots│  snap 2: 55% — one proposal card, options
│ │ Young families are…   │
│ │ [Fund three cottages] │
│ │ [Let households build]│
│ │                       │  snap 3: 92% — full binder scroll
│ ╰───────────────────────╯ + safe-area-bottom
└─────────────────────────┘
```

Tablet (720–1000): desktop layout but the right rail becomes a **side sheet** (overlay, 360 px) toggled by the tab strip at the bottom-right; the left rail stays.

Rules: all tappable targets ≥ 44×44 px; primary option buttons on phone are full-width, 52 px tall, in the bottom third of the sheet; `padding-bottom: env(safe-area-inset-bottom)`; sheet snap points 88 px / 55 % / 92 % with velocity-based snapping (`touchend` velocity > 0.4 px/ms picks the next snap in that direction); drag handle 36×5 px; scene gestures are blocked while the sheet is above snap 1.

### 8.2 Growth model

Tabs are **institutions**. Data: `institutions[] = {id, name, icon, founded, metrics[], docket[], policies[]}`. The UI renders:

- Year 0: one tab, "Council". No tab strip shown at all until a second institution exists (a single tab looks like a label).
- On founding: **reveal animation** — the new tab slides in from the right of the strip (280 ms, `cubic-bezier(.2,.8,.2,1)`), a paper-edge highlight sweeps across it once (gold `#c9a24a` at 20 %), and a chronicle entry "The Agricultural Council sits for the first time" pins for 6 s. A one-time 2-line explainer sits at the top of the new tab until dismissed.
- Up to 7 tabs fit on desktop; beyond that, the strip becomes scrollable with a fade, and the least-active tabs collapse to icons.
- Each institution tab has the same three sections, in order: **Docket** (needs your ruling), **Dashboard** (metrics with sparklines), **Policy book** (standing policies as a list of short cards, toggles disabled — policies change by proposals, not by switches).

### 8.3 Proposal card

```
┌───────────────────────────────────────────────┐
│ ● DECISION 2 OF 3           Farms · urgent ▲  │  eyebrow: 11px caps, tracking .08em
│ Room to put down roots                        │  title: 22px Fraunces 600
│ Young families are ready to settle. They      │  body: 15px, max 3 lines, "why now"
│ want to build this spring, before harvest.    │
│ ─ Mara, village steward  (avatar circle)      │  who asks
│ ┌─────────────────────────────────────────┐   │
│ │ Fund three cottages                   → │   │  option: 52px, primary (ink on green)
│ │ −¤2,040 · room for 18                   │   │  trade-off line, 13px
│ │ ▲ Farmers  ▼ Treasurer  ~ Guild         │   │  faction reactions: 3 chips, arrows coloured
│ └─────────────────────────────────────────┘   │
│ ┌─────────────────────────────────────────┐   │
│ │ Let households build                  → │   │  secondary (outlined)
│ │ No cost · slower · depends on wealth    │   │
│ └─────────────────────────────────────────┘   │
│ Defer to next season  ·  Ask for details      │  tertiary text links
└───────────────────────────────────────────────┘
```

Faction reaction chips are shown **before** the choice (they're the "System 2" information the player deliberates on). Confidence is implied by chip arrow size (▲ strong, ▵ mild). After choosing: the card folds (scaleY 1→0.96, opacity 180 ms), a chime, a chronicle line, and the next card slides up (220 ms). "Ask for details" expands an inline panel with the numbers the sim used (keep to 4 rows).

### 8.4 Dashboards

Each metric is a 1-line row: label, current value, a 60-point sparkline (inline SVG, 96×20, stroke 1.5 px, no axes), and a delta chip. Sparkline fill under the line at 12 % opacity. Max 6 metrics per institution. Colours: a single series per sparkline, using `--ink`; delta positive `--green`, negative `--rust`. No pie charts.

### 8.5 Chronicle / timeline

The feed shows the last 3 entries (fade older) at the bottom right of the open scene, above the time strip and beside the binder (or the dock when the binder is tucked away); where an open inspector or drawer leaves no room, it fades out. The inspector keeps the bottom left. A full **Chronicle** view (left rail icon) is a vertical timeline grouped by era, each era a heading with a tiny coloured swatch strip (era palette), entries as single lines with year + text, decisions marked with a seal icon. On phone it's a tab in the sheet.

### 8.6 Notifications

Three levels, never more than one toast visible:
- **Chronicle line** (passive, feed only): "Harvest came in well."
- **Nudge** (pill near the tab strip, auto-dismiss 6 s): "Council has 2 new proposals" — tapping focuses the docket.
Every toast, banner and nudge has a close button (44 px target) and can be swiped sideways on touch; its timer waits while it is hovered or focused, and Esc puts notices away when nothing else is open. Toasts and banners drop from the top centre of the scene.
- **Moment** (modal title card): era transitions, institution founding, disasters. It only tells, so Continue, a close button, Esc or a click on the backdrop (ignored for its first 0.7 s) dismiss it; "Skip the other cards" clears a queue. Its words stay in the Chronicle. Title cards: full-screen paper tint 60 %, era name in Fraunces 44 px with a thin rule, a 1-line subtitle, "Continue" button; scene behind does a 2 s slow dolly. Also used at year-end night beat ("Year 12 ends") with the three biggest changes listed. Holds the sim paused until dismissed; on phone the card is a sheet at 92 %.

Cadence guard: the UI queues nudges and shows at most one per 20 s of real time; the docket count badge is the always-on signal.

### 8.7 Time controls & settings

Time strip: pause / 1× / 3× / 8× as segmented control; a thin **era progress bar** (year within era) with the next era name; a season glyph. Keyboard: space pause, 1/2/3 speeds, `C` council, `Esc` closes sheets. Settings (gear): quality tier (Auto/Low/Med/High), Battery saver (Off/On battery/Always, §4.8), day cycle, motion (Full/Reduced), sound (master, ambience, UI), language size (Normal/Large = 1.15× root font), save/export/import, model status. Settings are grouped in ARIA tabs (Game, Display, Sound, Accessibility, Decision model; arrow keys move between them) and the last tab is remembered.

*Note (October 2026): the Council panel (`src/ui/components/council.js`) has replaced this modal. It sits over the main area and is not a dialog. The pause rule below is current.*

**The docket** is a large modal (about 90 % of the screen on desk and tablet, the town dimmed around it; a full-screen sheet on phones). It opens from the dock's top crest, the phone strip's Docket item, petitioner chips and nudges (at the new card), a body's request titles, or `D`, and closes with Esc, `D`, its close button or a click on the backdrop. Focus stays inside it and returns where it was. The town keeps its pace while it is open; the time controls stay in reach. With Settings → Game → New requests → "Pause and open", a new request pauses the town and opens it, and the old pace comes back when it closes (`src/ui/app.js`). It holds every waiting card in the docket's order, drawn and ruled exactly as before (one open card, the rest folded; a pager on phones), an index to filter by area or by the body that asks, the rules in force in the open card's area (with a link to the Rule Book drawer), and how the factions feel. The binder now holds the bodies' pages only (the Council gets one once it has a dashboard or the purse); each page lists its requests by title, and a title opens the docket at that card. The Rule Book stays a drawer listing; `R` opens or closes it, and a body's "Rule Book" link opens it.

### 8.8 Motion

| Token | Value | Use |
|---|---|---|
| `--t-fast` | 120 ms | hover, press |
| `--t-base` | 220 ms | card enter/exit, tab switch |
| `--t-slow` | 360 ms | sheet snap, reveal |
| `--t-moment` | 900 ms | title cards |
| `--ease-out` | `cubic-bezier(.2,.8,.2,1)` | enters |
| `--ease-in` | `cubic-bezier(.4,0,.8,.4)` | exits |
| `--ease-back` | `cubic-bezier(.34,1.3,.64,1)` | reveals |

`@media (prefers-reduced-motion: reduce)` and the Reduced setting: durations → 0, title cards fade only, 3D camera moments disabled, particles density 25 %.

### 8.9 Typography & colour tokens

Fonts (Google Fonts): **Fraunces** (variable, opsz) for titles and era names — it has the storybook warmth without being a script; **DM Sans** (keep) for body and UI; **JetBrains Mono** at 12 px for numbers in dashboards only (tabular digits). Sizes: 11/13/15/18/22/28/44 px. Line-height 1.45 body.

```css
:root{
  --paper:#fafbf2; --paper-2:#f2f3e6; --paper-glass:rgba(250,251,242,.86);
  --ink:#2f3f2f; --ink-2:#5a6a55; --muted:#7f8a73; --line:#dde3cf;
  --green:#526d42; --green-2:#6c8a58; --gold:#c9a24a; --rust:#b2563f; --river:#3f8a99;
  --radius:14px; --radius-s:8px;
  --shadow:0 8px 28px rgba(35,59,41,.12);
}
:root[data-theme="night"]{ --paper:#1f2622; --paper-glass:rgba(31,38,34,.86); --ink:#e8e9dc; ... }
```

Night theme follows the scene's night beat automatically (data-theme flips during the year-end night) and the system preference otherwise.

**Legibility over 3D:** every sheet uses `background: var(--paper-glass); backdrop-filter: blur(14px) saturate(1.1)` with a `@supports not (backdrop-filter)` fallback to 96 % opaque paper. Text never sits directly on the scene; floating labels (region name, "28 lives") always get a pill. The scene gets a 6 % ink vignette toward the rail side on desktop so the paper reads as "on top".

### 8.10 Iconography

Inline SVG, 24×24 viewBox, 1.75 px stroke, round caps/joins, `currentColor`. One `<svg><symbol>` sprite in `index.html`, referenced by `<use href="#i-council">`. Set: council (columned hall), farms (wheat), guild (hammer), treasury (coin stack), health (leaf-heart), works (bridge), harbour (anchor), schools (book), chronicle (scroll), map, sun, info, settings, pause/play, seal (decision), up/down/flat arrows for reactions.

---

## 9. Sound — procedural WebAudio

One `AudioContext` created on first user gesture. All sources are synthesised from three shared noise loops (white, pink, brown); no audio files. Buses: `ambience` (→ highpass 55 Hz → "air" lowpass that snow and height pull down), `ui`, and `space`, a cheap darkened ping-pong echo that distant event voices send into. Master → one soft-knee peak compressor. Ambience fades in over 4 s on first start. Measured cost in an offline render: ~1.7–2 % of one core (beds whose level is zero are disconnected so the audio thread stops pulling them).

Code: `src/audio/ambience.js` (scene factors, beds, scheduling), `river.js`, `voices.js` (event synths), `bus.js`. `audio.update(env)` runs at the UI refresh rate (~4 Hz); with `env.world` it reads the camera (listener position, zoom, right vector for panning), the grade's time of day (`grade.current.phase`, `night`) and the eased rain and snow.

- **Wind:** pink noise under a lowpass; random gusts (new target every 2.5–9 s, random time constant) move level and cutoff together. Louder with weather wind, camera height, snow and rain.
- **Leaves:** a soft rustle band (~0.8–5 kHz) whose level follows the gusts and the season's foliage (bare in winter, drier in autumn), with a fast random wobble.
- **River:** a low wash heard across the valley plus, near the water, a gurgle (three narrow bands whose levels hop at random) and scattered rising-pitch bubbles. Level falls with distance from the bank and camera height; pans toward the water's side; fords babble more; spring runs fuller. `audio.setWaterSources([{x, z, intensity, radius}])` adds a brighter rush near rapids or weirs.
- **Birds (day):** six perches; each bird keeps one motif (warbler, thrush, tit, sparrow, wren, wood pigeon, cuckoo in spring) and sings it with small variations in bouts, then rests. Dawn chorus at sunrise; fewer in rain, snow, winter and the town core.
- **Night and evening:** five crickets chirping in bouts on warm evenings (pitch and period per cricket, faster when warmer); frogs near water in spring and summer; an occasional tawny owl.
- **Village:** a murmur (two formant bands with syllable-rate wobble) that grows with population and nearness to a centre and pans toward it; a low street hum from the City era; mallets on building sites, an axe in early eras, a dog now and then, livestock bells in rural eras, a horse and cart in busier towns. Rain adds a dark hush and drips.
- All events are scheduled up to 0.6 s ahead with random gaps (never a fixed beat). Nothing is tuned above ~4 kHz, so there is no hiss.
- **Church/clock bell (era 2+/5+):** triangle wave 440 Hz + partials at 2.4× and 3.9× decaying over 2.5 s, plays at year end (bell count = era).
- **UI:** paper slide (filtered noise, 140 ms, highpass 1.2 kHz, fade) on card enter; **decision chime**: two sines (660 → 880 Hz, 90 ms apart, release 400 ms) at −14 dB; tab tick (3 ms click); **era fanfare**: three stacked triangle notes (C4-G4-C5 + minor 3rd on hard eras), 1.6 s, with the bell.
- Mute toggle in the time strip; levels in Settings; everything respects `document.hidden` (suspend context).

---

## 10. Implementation map

```
src/render/
  renderer.js      WebGLRenderer, quality application, loop (on-demand/capped), post pass
  quality.js       tier detection, persisted override, tier → settings table
  grade.js         uGrade uniform block, season/time keyframes, theme flip event
  sky.js           dome, sun disc, stars, clouds
  lights.js        hemi + sun, shadow follow/snap/refresh scheduling
  terrain.js       chunk geometry (2 densities), terrain shader (road splat, snow, cloud shadow)
  roads.js         tRoad DataTexture, dirty-rect upload, bridge/lamp placement from sim
  water.js         ribbon builder, normal tile DataTexture, water shader, planar reflection (high)
  kit/             one file per era: pieces as non-indexed geometries with aAO/aRoof/aPart
  buildings.js     per-piece InstancedMesh per LOD ring, slot allocator, lot → pieces composer, incremental updates, construction tweens
  decals.js        contact shadows, park/garden/event ring decals
  trees.js         instanced trees per LOD ring, seasons, chop/grow tweens
  people.js        single InstancedMesh villagers, shared Float32Array state, dirty-range upload
  particles.js     seasonal/weather/smoke/glow instanced quads
  props.js         stalls, bunting, lamps, boats, birds, windmill, fountain
  picking.js       lot/person hover via cheap id raycast against a coarse grid (not mesh raycast)

src/ui/
  app.js           mounts layers, routes state → components, breakpoints, sheet controller
  tokens.css       colour/motion/type tokens (light/night)
  layout.css       regions, bottom sheet, safe areas
  components/      card.js, docket.js, dashboard.js (sparkline svg), policybook.js, tabs.js,
                   chronicle.js, toast.js, titlecard.js, timestrip.js, settings.js, icons.js
  sheet.js         phone bottom sheet with snap points + velocity
  motion.js        tween helpers honouring reduced-motion

src/audio/
  ambience.js, ui-sounds.js, bus.js
```

### 10.1 Data contract from the simulation (read-only snapshots + change events)

```ts
// pushed each sim tick as a delta; renderer never reads sim internals
lots: Array<{
  id:number, type:'home'|'shop'|'workshop'|'farm'|'park'|'civic'|'market'|'school'|'church'|'factory'|'tower',
  tier:1..6, style:'thatch'|'stone'|'guild'|'terrace'|'civic'|'glass', region:'grey'|'honey',
  x:number, z:number, rot:0|1|2|3, w:number, d:number, floors:number,
  extensions:Array<{side:0..3, w:number, d:number}>,
  wealth:0..1, age:number /*years*/, built:0..1 /*construction progress*/,
  occupied:boolean, open:boolean /*shops*/, flags:{heritage?:1, derelict?:1, scaffold?:1}
}>
lotEvents: Array<{kind:'add'|'update'|'remove'|'upgrade', id:number}>   // per tick

people: Float32Array(rowsCap*16)   // shared with the worker; row = [x,y,z, vx,vy,vz, t0, phase, speed, action, actionT0, skin, cloth, hat, scale, facing]
peopleDirty: {start:number, end:number} | null
peopleCount: number

wear:  Float32Array(W*H); tiers: Uint8Array(W*H); roadMeta:{ox:number, oz:number, cell:number, W:number, H:number}
roadDirty: {x0,z0,x1,z1} | null
bridges: Array<{id, z:number, style:'timber'|'stone'|'iron'}>
lamps:  Array<{x,z}>            // sim places on tier>=4 cells

events: Array<{id, kind:'market'|'festival'|'protest'|'wedding'|'funeral'|'fire'|'flood', x,z, radius, strength:0..1, faction?:string, t0, t1}>
weather: {rain:0..1, wind:[x,z], snow:0..1, season:0..3, seasonT:0..1, dayT:0..1 /*derived*/}
year:number, era:1..6, eraT:0..1
camera hints: {focus?: {x,z, duration}}   // for moments; renderer owns the camera otherwise

institutions: Array<{id, name, icon, founded:number, metrics:Array<{id,label,unit,series:number[60],delta:number}>,
  docket:Array<Proposal>, policies:Array<{id,title,summary,since:number}>}>
Proposal: {id, institution, title, why:string, asker:{name,role}, urgency:0..2,
  options:Array<{key,label,tradeoff:string, cost?:number, reactions:Array<{faction, dir:-2..2}>}>,
  details?:Array<{label, value}>, deadlineYear?:number}
chronicle: Array<{year, season, text, kind:'line'|'decision'|'moment', era}>
```

### 10.2 Order of work

1. Flat normals + shadow follow/snap/bias (§3.1 items 1–4). One afternoon; fixes the visible glitch.
2. Water ribbon + shader, medium tier (§2). 
3. `grade.js` + sky dome + fog (§1.2, §3.4).
4. Building kit + instanced lots with incremental updates (§4.1–4.2) — the biggest change; do it with era 1–2 pieces first and a style fallback for the rest.
5. People single-mesh (§4.5).
6. Roads splat (§5).
7. Contact decals, seasons, particles (§3.3, §3.5, §7).
8. Quality tiers + battery (§4.7–4.8).
9. UI system (§8) can run in parallel from step 1 since it's DOM-only; wire to the contract in §10.1.
10. Sound (§9), planar reflection and post (high tier) last.
