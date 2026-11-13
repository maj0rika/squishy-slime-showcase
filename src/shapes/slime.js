import { buildBlobGeometry, pickDetail, pickSpacing } from './icosphere.js';

/**
 * Shape definition — the only file a new shape needs to imitate.
 *
 * Everything the rest of the app needs is here: how to build the mesh, how it
 * should feel, what it is made of, what colour it starts in, and how the
 * camera should frame it.
 */
export const slimeShape = {
  id: 'slime',
  name: '슬라임',

  build({ detail, spacing } = {}) {
    const { geometry, rest, vertexCount, bounds } = buildBlobGeometry(detail ?? pickDetail());
    const index = new Uint32Array(geometry.getIndex().array);
    return { geometry, rest, index, vertexCount, floorY: 0, spacing: spacing ?? pickSpacing(), bounds };
  },

  physics: { firmness: 0.4, recovery: 0.62, damping: 0.45, tack: 1.0 },
  material: 'mochi',
  color: 'strawberry',

  camera: {
    target: [0, 0.8, 0],
    azimuth: 0.34,
    polar: 1.36,
    radius: 1.24,
    margin: 1.3204,
  },
};
