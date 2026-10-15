import * as THREE from 'three';

// One InstancedMesh per kit piece with a slot allocator and partial uploads.
// Slots never move: a lot owns its slots until it is removed. Freed slots are
// hidden with a zero matrix and reused. Capacity grows by 1.5x when full
// (the only time attributes are reallocated).

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

// Per-instance attributes besides instanceMatrix / instanceColor.
export const INSTANCE_ATTRS = [
  ['iRoof', 3],
  ['iTrim', 3],
  ['iParams', 4], // condition, lit, age (0..1), seed
  ['iStyle', 4], // floorH, window kind (or accent index), roof kind, detail flags
  ['iShape', 4], // sink (body bottom -> ground floor), overhang, thickness, wealth
];

export class PieceBatch {
  constructor(name, geometry, material, depthMaterial, { capacity = 64, castShadow = true, receiveShadow = true } = {}) {
    this.name = name;
    this.baseGeometry = geometry;
    this.material = material;
    this.capacity = 0;
    this.high = 0; // high-water mark = instance count drawn
    this.free = [];
    this.lo = Infinity;
    this.hi = -1;
    this.mesh = new THREE.InstancedMesh(geometry, material, 1);
    this.mesh.name = `kit:${name}`;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = castShadow;
    this.mesh.receiveShadow = receiveShadow;
    if (depthMaterial) this.mesh.customDepthMaterial = depthMaterial;
    this.grow(capacity);
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  grow(next) {
    const old = this.capacity;
    const geometry = this.baseGeometry.clone();
    const matrix = new THREE.InstancedBufferAttribute(new Float32Array(next * 16), 16);
    const color = new THREE.InstancedBufferAttribute(new Float32Array(next * 3), 3);
    matrix.setUsage(THREE.DynamicDrawUsage);
    color.setUsage(THREE.DynamicDrawUsage);
    if (old) {
      matrix.array.set(this.mesh.instanceMatrix.array.subarray(0, old * 16));
      color.array.set(this.mesh.instanceColor.array.subarray(0, old * 3));
    }
    for (let i = old; i < next; i++) ZERO.toArray(matrix.array, i * 16);
    for (const [name, size] of INSTANCE_ATTRS) {
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(next * size), size);
      attr.setUsage(THREE.DynamicDrawUsage);
      if (old) attr.array.set(this.mesh.geometry.getAttribute(name).array.subarray(0, old * size));
      geometry.setAttribute(name, attr);
    }
    if (old) this.mesh.geometry.dispose();
    this.mesh.geometry = geometry;
    this.mesh.instanceMatrix = matrix;
    this.mesh.instanceColor = color;
    this.capacity = next;
    // Everything must re-upload once after a reallocation.
    this.lo = 0;
    this.hi = Math.max(this.high - 1, 0);
    this.full = true;
  }

  alloc() {
    if (this.free.length) return this.free.pop();
    if (this.high >= this.capacity) this.grow(Math.ceil(this.capacity * 1.5) + 16);
    return this.high++;
  }

  release(index) {
    ZERO.toArray(this.mesh.instanceMatrix.array, index * 16);
    this.touch(index);
    this.free.push(index);
  }

  touch(index) {
    if (index < this.lo) this.lo = index;
    if (index > this.hi) this.hi = index;
  }

  /** Write one instance from a piece spec (see compose.js). */
  write(index, s, matrix) {
    const g = this.mesh.geometry;
    matrix.toArray(this.mesh.instanceMatrix.array, index * 16);
    s.wall.toArray(this.mesh.instanceColor.array, index * 3);
    s.roof.toArray(g.attributes.iRoof.array, index * 3);
    s.trim.toArray(g.attributes.iTrim.array, index * 3);
    g.attributes.iParams.array.set(s.params, index * 4);
    g.attributes.iStyle.array.set(s.style, index * 4);
    g.attributes.iShape.array.set(s.shape, index * 4);
    this.touch(index);
  }

  /** Write only the matrix (tweens). */
  writeMatrix(index, matrix) {
    matrix.toArray(this.mesh.instanceMatrix.array, index * 16);
    this.touch(index);
  }

  /** Upload the dirty range once per frame. */
  flush() {
    this.mesh.count = this.high;
    this.mesh.visible = this.high - this.free.length > 0;
    if (this.hi < this.lo) return false;
    const lo = this.lo;
    const n = this.hi - this.lo + 1;
    const g = this.mesh.geometry;
    const attrs = [this.mesh.instanceMatrix, this.mesh.instanceColor, ...INSTANCE_ATTRS.map(([name]) => g.attributes[name])];
    for (const a of attrs) {
      a.clearUpdateRanges();
      if (!this.full) a.addUpdateRange(lo * a.itemSize, n * a.itemSize);
      a.needsUpdate = true;
    }
    this.full = false;
    this.lo = Infinity;
    this.hi = -1;
    return true;
  }

  live() {
    return this.high - this.free.length;
  }
}
