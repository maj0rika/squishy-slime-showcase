/**
 * App-wide tunables. Anything a designer or engineer may want to adjust
 * without touching the simulation lives here.
 */

export const CONFIG = {
  /**
   * Real-world scale. One simulation unit is 3.6 cm, so the toy is about 7 cm
   * wide and 6 cm tall. Gravity 30 units/s² in simulation time equals 9.8 m/s²
   * only when simulation time runs `simulation.timeScale` (= 3) times faster
   * than wall-clock time, which is what the main loop does.
   */
  scale: {
    unitCm: 3.6,
  },

  simulation: {
    // Simulation seconds per substep. With timeScale 3 a 60 fps frame advances
    // 3/60 simulation seconds = 9 substeps.
    fixedDt: 1 / 180,
    timeScale: 3,
    maxSubsteps: 14,
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
      // Finger push force, in units of the body's own weight (v7). The pointer
      // layer turns touch/hold/contact-area into a force; the solver turns the
      // force into a depth that depends on the material.
      push: {
        touch: 0.06,
        touchEaseSeconds: 0.06,
        holdStartSeconds: 0.15,
        holdPerSecond: 0.45,
        holdMax: 0.8,
        areaGain: 0.5,
        max: 1.0,
        pullDecay: 0.3,
        freeForce: 0.05,
      },
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
    physics: { firmness: 0.2, recovery: 0.62, damping: 0.2, tack: 1.0, fuse: 1, weldBreak: 1.35, edgeMix: 0.015, weldMix: 0.25, weldLife: 0.5, viscoRelease: 8, creepTime: 0, shapeRate: 6, pushGain: 1.3 },
  },
};
