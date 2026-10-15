import * as THREE from 'three';

// Hemisphere + sun rig with a shadow box that follows the camera target
// (design-visual §3.1). The shadow map is static: it re-renders only when
// something asks for it, and at most a few times per second.

const ORIGIN = new THREE.Vector3();

const SHADOW_TYPES = {
  basic: THREE.BasicShadowMap,
  pcf: THREE.PCFShadowMap,
  pcfsoft: THREE.PCFSoftShadowMap,
};

export function createLights({ renderer, scene, grade }) {
  const hemi = new THREE.HemisphereLight('#dcefff', '#6e7d4a', 1.4);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight('#fff1d6', 2.8);
  sun.castShadow = true;
  sun.shadow.bias = -0.0006;
  scene.add(sun);
  scene.add(sun.target);

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;

  const shadowCam = sun.shadow.camera;
  const lightView = new THREE.Matrix4();
  const lightViewInv = new THREE.Matrix4();
  const snapped = new THREE.Vector3();
  const lastTarget = new THREE.Vector3(1e9, 0, 0);
  const lastSunDir = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  let radius = 90;
  let dirty = true;
  let lastShadowTime = -1;
  let animatingUntil = 0;
  let minInterval = 0.25;
  let turnInterval = 0;
  // Longest shadow that matters (a tall building at a low sun), in metres.
  const SHADOW_REACH = 20;

  function applyQuality(q) {
    const size = q.shadowMapSize;
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.mapSize.set(size, size);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    const type = SHADOW_TYPES[q.shadowType] ?? THREE.PCFShadowMap;
    if (renderer.shadowMap.type !== type) {
      renderer.shadowMap.type = type;
      // Materials compile shadow sampling per type; flag them for rebuild.
      scene.traverse((o) => {
        const m = o.material;
        if (!m) return;
        for (const mm of Array.isArray(m) ? m : [m]) mm.needsUpdate = true;
      });
    }
    sun.shadow.radius = q.shadowRadius;
    minInterval = q.name === 'high' ? 0.25 : 0.5;
    // While the sun turns, refresh as soon as shadows would move half a texel:
    // every frame on medium/high, at most 10 Hz on low.
    turnInterval = q.name === 'low' ? 0.1 : 0;
    dirty = true;
  }

  /** Ask for one shadow refresh (a building changed, a tree fell...). */
  function markDirty() {
    dirty = true;
  }

  /** Keep the shadow map refreshing for a while (animated casters on screen). */
  function animateFor(seconds, now) {
    animatingUntil = Math.max(animatingUntil, now + seconds);
  }

  /**
   * Follow the view target: size the box from the camera distance, snap the
   * centre to whole shadow texels in light space so edges never shimmer.
   * The shadow camera only moves on the frame the map re-renders, so the
   * receivers never sample a map drawn from a different box.
   */
  function update(target, distance, time) {
    const sunDir = grade.uniforms.uSunDir.value;
    const wantRadius = THREE.MathUtils.clamp(distance * 0.95, 45, 170);
    const resized = Math.abs(wantRadius - radius) > radius * 0.08;
    const r = resized ? wantRadius : radius;
    const texel = (2 * r) / sun.shadow.mapSize.x;

    // Light-space basis from the sun direction alone (independent of target).
    lightView.lookAt(sunDir, ORIGIN, up);
    lightViewInv.copy(lightView).invert();
    snapped.copy(target).applyMatrix4(lightViewInv);
    snapped.x = Math.round(snapped.x / texel) * texel;
    snapped.y = Math.round(snapped.y / texel) * texel;
    snapped.applyMatrix4(lightView);

    // Lighting direction follows the sun every frame. The shadow matrices only
    // update when the map re-renders, so receivers always match the map.
    sun.position.copy(sun.target.position).addScaledVector(sunDir, 260);

    const moved = snapped.distanceToSquared(lastTarget) > texel * texel * 4;
    // Half a texel of movement at the end of the longest shadow.
    const turned = sunDir.angleTo(lastSunDir) > (0.5 * texel) / SHADOW_REACH;
    if (moved || resized) dirty = true;

    const since = time - lastShadowTime;
    const animating = time < animatingUntil;
    const due = (turned && since >= turnInterval) || ((dirty || animating) && since >= minInterval);
    if (!due) return;

    radius = r;
    sun.target.position.copy(snapped);
    sun.position.copy(snapped).addScaledVector(sunDir, 260);
    shadowCam.left = -r; shadowCam.right = r; shadowCam.top = r; shadowCam.bottom = -r;
    shadowCam.near = 60; shadowCam.far = 480;
    shadowCam.updateProjectionMatrix();
    // Normal bias in world units scales with texel size so it stays ~1 texel.
    sun.shadow.normalBias = 0.02 * (r / 90);
    lastTarget.copy(snapped);
    lastSunDir.copy(sunDir);
    renderer.shadowMap.needsUpdate = true;
    lastShadowTime = time;
    dirty = false;
  }

  return { hemi, sun, update, markDirty, animateFor, applyQuality, radius: () => radius };
}
