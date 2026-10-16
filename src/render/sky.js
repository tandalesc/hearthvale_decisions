import * as THREE from 'three';
import { LAYER_REFLECT, hashId, patchMaterial } from './shaderlib.js';

// Sky dome with a three-stop gradient, sun disc and halo, night stars and a
// few drifting low-poly clouds (design-visual §3.4). Three draw calls.

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  // Follow the camera: drop translation, keep the dome at the far plane.
  vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

const DOME_FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uFogTint;
uniform float uNight;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  // Horizon band blends into the fog colour so terrain fades into the sky.
  vec3 mid = mix(uSkyHorizon, uSkyZenith, 0.45);
  vec3 col = mix(uSkyHorizon, mid, smoothstep(0.0, 0.18, h));
  col = mix(col, uSkyZenith, smoothstep(0.18, 0.75, h));
  col = mix(uFogTint, col, smoothstep(-0.04, 0.08, h));
  float s = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(s, 900.0) * 3.0 * (1.0 - uNight * 0.6) + pow(s, 10.0) * 0.16);
  // Dither to stop 8-bit banding in the long gradient.
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const STAR_VERT = /* glsl */ `
attribute float aSize;
uniform float uNight;
uniform float uTime;
uniform float uPixelRatio;
varying float vAlpha;
void main() {
  vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
  gl_Position = p.xyww;
  float twinkle = 0.75 + 0.25 * sin(uTime * 1.7 + position.x * 0.13);
  vAlpha = smoothstep(0.35, 0.9, uNight) * twinkle;
  gl_PointSize = aSize * uPixelRatio;
}
`;

const STAR_FRAG = /* glsl */ `
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.1, length(c)) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vec3(0.96, 0.95, 0.88), a);
}
`;

export function createSky({ scene, grade }) {
  const domeGeo = new THREE.SphereGeometry(700, 24, 12);
  const domeMat = new THREE.ShaderMaterial({
    uniforms: grade.uniforms,
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.frustumCulled = false;
  dome.renderOrder = -10;
  dome.layers.enable(LAYER_REFLECT);
  scene.add(dome);

  // 160 stars on the upper hemisphere, deterministic.
  const starCount = 160;
  const starPos = new Float32Array(starCount * 3);
  const starSize = new Float32Array(starCount);
  for (let i = 0; i < starCount; i++) {
    const u = hashId(i, 1) * Math.PI * 2;
    const v = 0.12 + hashId(i, 2) * 0.88;
    const r = Math.sqrt(1 - v * v);
    starPos.set([Math.cos(u) * r * 650, v * 650, Math.sin(u) * r * 650], i * 3);
    starSize[i] = 1.2 + hashId(i, 3) * 2.2;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(starSize, 1));
  const starUniforms = { ...grade.uniforms, uPixelRatio: { value: 1 } };
  const stars = new THREE.Points(starGeo, new THREE.ShaderMaterial({
    uniforms: starUniforms,
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    depthWrite: false,
  }));
  stars.frustumCulled = false;
  stars.renderOrder = -9;
  scene.add(stars);

  const clouds = createClouds(grade);
  scene.add(clouds.mesh);

  function update(time, pixelRatio, target) {
    if (target) clouds.target.copy(target);
    starUniforms.uPixelRatio.value = pixelRatio;
    stars.visible = grade.uniforms.uNight.value > 0.3;
    clouds.update(time);
  }

  return { dome, stars, clouds: clouds.mesh, update };
}

// A dozen chunky clouds merged into one mesh; they drift slowly and wrap.
function createClouds(grade) {
  const cloudTarget = { value: new THREE.Vector3() };
  const parts = [];
  const puff = new THREE.IcosahedronGeometry(1, 0);
  for (let c = 0; c < 12; c++) {
    const cx = (hashId(c, 11) - 0.5) * 900;
    const cz = (hashId(c, 12) - 0.5) * 900;
    const cy = 130 + hashId(c, 13) * 30;
    const n = 4 + Math.floor(hashId(c, 14) * 4);
    for (let i = 0; i < n; i++) {
      const g = puff.clone();
      const s = 6 + hashId(c * 10 + i, 15) * 7;
      g.scale(s * 1.3, s * 0.55, s);
      const px = cx + (i - n / 2) * 7 + hashId(c * 10 + i, 16) * 4, py = cy + hashId(c * 10 + i, 17) * 3, pz = cz + (hashId(c * 10 + i, 18) - 0.5) * 8;
      g.translate(px, py, pz);
      const flat = g.index ? g.toNonIndexed() : g;
      // Each vertex knows its puff's centre and size, so a puff fades as a whole.
      const k = flat.attributes.position.count;
      const puffAttr = new Float32Array(k * 4);
      for (let v = 0; v < k; v++) puffAttr.set([px, py, pz, s * 1.3], v * 4);
      flat.setAttribute('aPuff', new THREE.BufferAttribute(puffAttr, 4));
      parts.push(flat);
    }
  }
  const merged = mergeSimple(parts);
  merged.computeVertexNormals();
  const material = new THREE.MeshLambertMaterial({ color: '#f6f3ea', transparent: true, opacity: 0.88, depthWrite: false, flatShading: true });
  // Clouds are scenery for low views; they fade out as the camera nears or
  // rises past them, so a zoomed-out top-down view never looks through fog.
  patchMaterial(material, grade, {
    key: 'clouds',
    vertexHead: 'attribute vec4 aPuff;\nvarying vec3 vCloudW;\nvarying float vPuffFade;\n',
    // A whole puff fades as the camera comes within a few of its own sizes, so
    // the near plane never slices a puff that is still visible.
    vertexEnd: 'vCloudW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvec3 puffW = (modelMatrix * vec4(aPuff.xyz, 1.0)).xyz;\nvPuffFade = smoothstep(aPuff.w * 1.2, aPuff.w * 3.5, distance(puffW, cameraPosition));\n',
    uniforms: { uCloudTarget: cloudTarget },
    // Sky light scattered through the cloud: undersides stay soft and pale
    // rather than turning to grey stone now that clouds share the haze.
    fragmentHead: 'varying vec3 vCloudW;\nvarying float vPuffFade;\nuniform vec3 uCloudTarget;\nuniform vec3 uSkyHorizon;\n',
    fragmentEmissive: 'totalEmissiveRadiance += diffuseColor.rgb * uSkyHorizon * 0.55;',
    fragmentEnd: `
      // Fly-through: a cloud dissolves as the camera nears it (puffs are
      // ~10 m, so fade from 10 to 45 m) instead of filling the screen.
      vec3 toCloud = vCloudW - cameraPosition;
      float camD = length(toCloud);
      float nearFade = smoothstep(10.0, 45.0, camD);
      // Look-through: clouds between the camera and the orbit target, near the
      // middle of the view, thin out so they never hide the town.
      vec3 toTarget = uCloudTarget - cameraPosition;
      float targetD = length(toTarget);
      float aligned = smoothstep(0.93, 0.99, dot(toCloud / camD, toTarget / targetD));
      float inFront = 1.0 - smoothstep(targetD * 0.85, targetD, camD);
      // Seen from above, clouds become thin veils rather than a white floor.
      float above = mix(0.3, 1.0, smoothstep(-10.0, 30.0, vCloudW.y - cameraPosition.y));
      gl_FragColor.a *= nearFade * vPuffFade * above * (1.0 - 0.9 * aligned * inFront);
    `,
  });
  const mesh = new THREE.Mesh(merged, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  return {
    mesh,
    target: cloudTarget.value,
    update(time) {
      // Drift 0.6 m/s along the wind, wrapping over a 900 m tile.
      mesh.position.x = ((time * 0.6 + 450) % 900) - 450;
    },
  };
}

/** Merge non-indexed geometries that share position/normal layouts. */
export function mergeSimple(geometries) {
  let count = 0;
  for (const g of geometries) count += g.attributes.position.count;
  const out = new THREE.BufferGeometry();
  const names = Object.keys(geometries[0].attributes);
  for (const name of names) {
    const size = geometries[0].attributes[name].itemSize;
    const array = new Float32Array(count * size);
    let offset = 0;
    for (const g of geometries) {
      const a = g.attributes[name];
      array.set(a.array, offset);
      offset += a.array.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(array, size));
  }
  return out;
}
