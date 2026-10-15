import * as THREE from 'three';

// Era style packs (contract §1, design-visual §1.1 and §1.3). Each pack says
// how a building of that era looks: palettes (3 hues per family), roof form
// and pitch, storey height, window kind, wall details. Later eras add
// materials but never remove earlier ones; a 150-year town keeps thatch in
// its old quarter because each building keeps its own styleEra.

const c = (h) => new THREE.Color(h);
const fam = (...hexes) => hexes.map(c);

export const PALETTE = {
  limewash: fam('#efe6cf', '#e6dcc2', '#f1ead8'),
  timber: fam('#8c6a44', '#7a5a3a', '#a07b52'),
  thatch: fam('#c9a86a', '#b89a5c', '#bfa063'),
  shingle: fam('#8a7358', '#7d6850', '#94795b'),
  stoneGrey: fam('#9a9a90', '#8b8c84', '#a9a89c'),
  stoneHoney: fam('#c8b48a', '#bba57c', '#c4ae86'),
  brick: fam('#a8553f', '#9c4e3b', '#b46450'),
  slate: fam('#626a70', '#585f66', '#6a6f72'),
  tile: fam('#b06a52', '#a26048', '#b8735a'),
  stucco: fam('#e9dfd0', '#dcd2c3', '#f0e8dc'),
  pastel: fam('#e8d2b0', '#d9c6a8', '#e6d9bf', '#cfd8c8', '#e3c9b5'),
  concrete: fam('#bdb8ae', '#b0aba1', '#c6c1b6'),
  greenRoof: fam('#7d9a5a', '#86a062', '#738f52'),
  flat: fam('#8e8a82', '#99958c'),
};

export const TRIM_LIGHT = c('#f4efe4');
export const TRIM_WARM = c('#e9dcc0');
export const TRIM_DARK = c('#4a3b2c');

// Window kinds understood by the building shader.
export const WINDOW = { NONE: 0, COTTAGE: 1, SASH: 2, TALL: 3, BANDS: 4, SHOP: 5, INDUSTRIAL: 6, LANCET: 7 };
// Roof surface patterns.
export const ROOF = { THATCH: 0, TILE: 1, SLATE: 2, SHINGLE: 3, FLAT: 4, GREEN: 5, METAL: 6 };
// Wall detail bit flags.
export const DETAIL = { HALF_TIMBER: 1, QUOINS: 2, STRING: 4, PLINTH: 8, PLANKS: 16, NO_DOOR: 32 };

/** Style packs indexed by era (0 hearth .. 5 glass). */
export const STYLES = [
  {
    name: 'hearth', floorH: 2.7, fill: 0.7, pitch: 47, roofForm: 'thatch', overhang: 0.5, thickness: 0.38,
    walls: ['limewash', 'limewash', 'timber'], roofs: [['thatch', ROOF.THATCH], ['thatch', ROOF.THATCH], ['shingle', ROOF.SHINGLE]],
    window: WINDOW.COTTAGE, details: [DETAIL.HALF_TIMBER, 0, DETAIL.PLANKS], chimney: 'stoneGrey', maxStoreys: 2,
  },
  {
    name: 'stone', floorH: 2.8, fill: 0.76, pitch: 42, roofForm: 'gable', overhang: 0.32, thickness: 0.2,
    walls: ['stoneGrey', 'stoneHoney', 'limewash'], roofs: [['tile', ROOF.TILE], ['slate', ROOF.SLATE], ['tile', ROOF.TILE]],
    window: WINDOW.COTTAGE, details: [DETAIL.QUOINS | DETAIL.PLINTH, DETAIL.QUOINS, DETAIL.HALF_TIMBER], chimney: 'stoneGrey', maxStoreys: 2,
  },
  {
    name: 'guild', floorH: 3.0, fill: 0.86, pitch: 44, roofForm: 'gable', overhang: 0.28, thickness: 0.18, gableToStreet: true,
    walls: ['brick', 'limewash', 'brick'], roofs: [['slate', ROOF.SLATE], ['tile', ROOF.TILE], ['slate', ROOF.SLATE]],
    window: WINDOW.SASH, details: [DETAIL.PLINTH, DETAIL.HALF_TIMBER | DETAIL.PLINTH, DETAIL.STRING], chimney: 'brick', maxStoreys: 3,
  },
  {
    name: 'terrace', floorH: 3.1, fill: 0.94, pitch: 34, roofForm: 'gable', overhang: 0.18, thickness: 0.16,
    walls: ['brick', 'stucco', 'pastel'], roofs: [['slate', ROOF.SLATE], ['slate', ROOF.SLATE], ['tile', ROOF.TILE]],
    window: WINDOW.SASH, details: [DETAIL.STRING | DETAIL.PLINTH, DETAIL.STRING | DETAIL.PLINTH, DETAIL.STRING], chimney: 'brick', maxStoreys: 4, mansard: 0.3,
  },
  {
    name: 'civic', floorH: 3.4, fill: 0.94, pitch: 16, roofForm: 'hip', overhang: 0.4, thickness: 0.22,
    walls: ['stoneHoney', 'stucco', 'concrete'], roofs: [['slate', ROOF.SLATE], ['flat', ROOF.FLAT], ['slate', ROOF.SLATE]],
    window: WINDOW.TALL, details: [DETAIL.STRING | DETAIL.PLINTH | DETAIL.QUOINS, DETAIL.STRING | DETAIL.PLINTH, DETAIL.PLINTH], chimney: 'brick', maxStoreys: 6, flatChance: 0.45,
  },
  {
    name: 'glass', floorH: 3.3, fill: 0.9, pitch: 6, roofForm: 'flat', overhang: 0.3, thickness: 0.2,
    walls: ['stucco', 'timber', 'concrete'], roofs: [['greenRoof', ROOF.GREEN], ['flat', ROOF.FLAT], ['greenRoof', ROOF.GREEN]],
    window: WINDOW.BANDS, details: [DETAIL.PLINTH, DETAIL.PLANKS, DETAIL.STRING], chimney: 'concrete', maxStoreys: 10,
  },
];

/** Style pack for a building's styleEra, clamped. */
export function styleFor(era) {
  return STYLES[Math.max(0, Math.min(STYLES.length - 1, era | 0))];
}
