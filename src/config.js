/**
 * App-wide tunables. Anything a designer or engineer may want to adjust
 * without touching the simulation lives here.
 */

export const CONFIG = {
  simulation: {
    fixedDt: 1 / 360,
    maxSubsteps: 8,
    maxFrameDt: 0.05,
    gravity: 30,
    maxSpeed: 30,
    boundsRadius: 2.8,
    ceiling: 4.2,
    floorFriction: 0.7,
    freeFriction: 0.12,
    fastSlip: 100,
    staticFriction: 0.05,
    dropHeight: 1.1,
  },

  feel: {
    shapeRampSeconds: 0.35,
  },

  grab: {
    maxHands: 10,
    pull: {
      radius: 0.42,
      falloff: 1.6,
      maxDrag: 2.4,
      dentDepth: 0.16,
      dentEaseSeconds: 0.12,
      dentDragDecay: 0.3,
      holdSinkPerSecond: 0.6,
      holdMaxDepth: 0.5,
      holdMaxRadius: 0.62,
    },
    press: {
      radius: 1.25,
      minThickness: 0.38,
      // The palm may not press the body thinner than this many simulation layers
      // (the effective floor is max(minThickness, pressMinLayers · spacing)), so
      // a deep press can never crush a single layer of tets through itself.
      pressMinLayers: 2.5,
      depthPerSecond: 0.9,
      holdMaxFraction: 0.45,
      dragGain: 2.2,
    },
  },

  knead: {
    collideFactor: 1.2,
    restFar: 2.6,
    maxWelds: 6000,
    mixActivityFloor: 0.4,
  },

  camera: {
    fov: 34,
    near: 0.1,
    far: 1000,
    minDistance: 2.4,
    maxDistance: 14,
    minPolar: 0.62,
    maxPolar: 1.45,
    damping: 0.065,
    rotateSpeed: 0.7,
    zoomSpeed: 0.8,
    resetTweenSeconds: 0.6,
    followRate: 2.5,
  },

  render: {
    maxPixelRatio: 2,
    shadowMapSize: 2048,
    mobileShadowMapSize: 1024,
    background: '#efeae2',
    implicitResolution: { desktop: 40, mobile: 28 },
  },

  defaults: {
    color: 'strawberry',
    material: 'mochi',
    tool: 'pull',
    feel: 'squishy',
    physics: { firmness: 0.3, recovery: 0.62, damping: 0.45, tack: 1.0, fuse: 1, weldBreak: 1.35, edgeMix: 0.015, weldMix: 0.25, weldLife: 0.5, viscoRelease: 200, shapeRate: 17 },
  },
};
