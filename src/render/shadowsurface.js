import * as THREE from 'three';

// One shadow surface for the ground. Every soft shadow that is not in the sun's
// shadow map (people's, and trees' with 'soft' tree shadows) is drawn, before
// the frame, into a top-down coverage map round the view:
//   R  sun coverage: how much of the sun the caster blocks there (0..1)
//   G  contact: the soft dark right under feet and trunks (sky shade, AO)
//   B  the height of the surface the shadow lies on (ground, deck, ramp)
// Coverage is the union (MAX blending), so crossing shadows never add up.
// Lit materials then take the sun away where it says (COVER_APPLY): exactly
// what the sun's shadow map does, on the same term. A shadow is a shadow: a
// walker's in a building's shade is no darker than the shade, the two meet
// without an edge, the depth is the scene's own (deeper at noon, fading with
// rain and dusk), and nothing is blended over the frame afterwards. The
// contact part darkens all the light a little, in sun or shade.

export const COVER_GLSL = /* glsl */ `
uniform sampler2D uShadowCover;
uniform mat4 uCoverMatrix;
uniform float uCoverOn;
`;

// Injected before <aomap_fragment> (patchMaterial), where the direct and
// indirect light are still apart. Only surfaces at the shadow's own height
// take it (the ground, a deck, a field), not roofs or walls above it.
export const COVER_APPLY = /* glsl */ `
#ifdef USE_FOG
  if (uCoverOn > 0.5) {
    vec4 coverClip = uCoverMatrix * vec4(vHvWorld, 1.0);
    vec2 coverUv = coverClip.xy * 0.5 + 0.5;
    if (coverUv.x > 0.0 && coverUv.y > 0.0 && coverUv.x < 1.0 && coverUv.y < 1.0) {
      vec4 cover = texture2D(uShadowCover, coverUv);
      float onIt = 1.0 - smoothstep(0.3, 0.5, abs(vHvWorld.y - cover.b));
      // The rim of the map fades, so the edge of the covered area never shows.
      vec2 rim = min(coverUv, 1.0 - coverUv);
      onIt *= smoothstep(0.0, 0.06, min(rim.x, rim.y));
      reflectedLight.directDiffuse *= 1.0 - clamp(cover.r, 0.0, 1.0) * onIt;
      float contact = clamp(cover.g, 0.0, 1.0) * onIt;
      reflectedLight.directDiffuse *= 1.0 - contact;
      reflectedLight.indirectDiffuse *= 1.0 - contact;
    }
  }
#endif
`;

export function createShadowSurface(renderer, grade) {
  let size = 0;
  let target = null;
  const scene = new THREE.Scene();
  scene.matrixWorldAutoUpdate = true;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2000);
  camera.up.set(0, 0, -1);
  const uniforms = {
    uShadowCover: { value: null },
    uCoverMatrix: { value: new THREE.Matrix4() },
    uCoverOn: { value: 0 },
    // Where the casters' LOD and fades measure from: the main camera.
    uEye: { value: new THREE.Vector3() },
  };
  // Lit materials read these through the grade (patchMaterial merges them).
  Object.assign(grade.uniforms, uniforms);

  function allocate(n) {
    if (n === size) return;
    size = n;
    target?.dispose();
    target = new THREE.WebGLRenderTarget(n, n, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    target.texture.colorSpace = THREE.NoColorSpace;
    uniforms.uShadowCover.value = target.texture;
  }

  const clear = new THREE.Color();
  /** Draw the casters round the view target into the coverage map. */
  function render(centre, distance, eye) {
    if (!size || !scene.children.some((c) => c.visible)) {
      uniforms.uCoverOn.value = 0;
      return;
    }
    // A square that grows with the view, snapped to whole texels so the
    // shadows never shimmer as the camera pans.
    const span = THREE.MathUtils.clamp((distance ?? 120) * 2.4, 90, 300);
    const texel = span / size;
    const cx = Math.round(centre.x / texel) * texel, cz = Math.round(centre.z / texel) * texel;
    camera.left = -span / 2; camera.right = span / 2; camera.top = span / 2; camera.bottom = -span / 2;
    camera.position.set(cx, 800, cz);
    camera.lookAt(cx, 0, cz);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    uniforms.uCoverMatrix.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    uniforms.uEye.value.copy(eye);
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.getClearColor(clear);
    const prevAlpha = renderer.getClearAlpha();
    // This scene has no lights; keep a pending shadow refresh for the frame.
    const prevShadow = renderer.shadowMap.autoUpdate, prevNeeds = renderer.shadowMap.needsUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = false;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.autoClear = false;
    renderer.render(scene, camera);
    renderer.autoClear = prevAuto;
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(clear, prevAlpha);
    renderer.shadowMap.autoUpdate = prevShadow;
    renderer.shadowMap.needsUpdate = prevNeeds;
    uniforms.uCoverOn.value = 1;
  }

  return {
    scene,
    uniforms,
    render,
    target: () => target,
    /** Coverage resolution by tier. */
    applyQuality(q) {
      allocate(q.name === 'high' ? 2048 : 1024);
    },
    dispose() {
      target?.dispose();
    },
  };
}
