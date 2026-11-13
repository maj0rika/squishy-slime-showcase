import { CONFIG } from '../config.js';

export const PHYSICS_PRESET = {
  id: 'xpbd-v2',
  label: 'XPBD 소프트바디',
};

/**
 * Feel presets (chip order). `tack`, `fuse`, `weldBreak`, `edgeMix`, `weldMix`,
 * `weldLife`, `viscoRelease` and `shapeRate` are hidden inputs (not sliders):
 * how strongly the base sticks to the table, whether a fold fuses, how far a
 * weld stretches before it breaks, how fast kneading streaks colours along the
 * material, how fast folded surfaces pressed together blend, how long a
 * temporary weld survives at rest, extra damping applied only while the body
 * recovers after a gesture (so a slow-rising foam settles without wobble), and
 * the strength of the global shape-matching memory. They are exposed to
 * resolvePhysics only.
 *
 *   말랑이  soft silicone: soft, rises back with a gentle damped wobble
 *   슬로우  slow-rising PU foam: sinks under a finger and rises back slowly
 *   슬라임  plastic slime: keeps the shape it is kneaded into
 *   탱탱볼  bouncy ball: firm, snaps back fast with a lively rebound
 */
export const FEEL_PRESETS = [
  { id: 'squishy', label: '말랑이', values: { firmness: 0.2, recovery: 0.62, damping: 0.2, tack: 1.0, fuse: 1, weldBreak: 1.35, edgeMix: 0.015, weldMix: 0.25, weldLife: 0.5, viscoRelease: 8, creepTime: 0, shapeRate: 6, pushGain: 1.3 } },
  { id: 'slow', label: '슬로우', values: { firmness: 0.35, recovery: 0.36, damping: 0.9, tack: 1.2, fuse: 1, weldBreak: 1.35, edgeMix: 0.02, weldMix: 0.3, weldLife: 0.5, viscoRelease: 0, creepTime: 0.12, shapeRate: 0.3, pushGain: 4 } },
  { id: 'slime', label: '슬라임', values: { firmness: 0.4, recovery: 0.04, damping: 0.7, tack: 1.6, fuse: 1, weldBreak: 4.0, edgeMix: 0.06, weldMix: 0.6, weldLife: 1e9, viscoRelease: 0, creepTime: 0, shapeRate: 0, pushGain: 2.2 } },
  { id: 'bouncy', label: '탱탱볼', values: { firmness: 0.8, recovery: 0.95, damping: 0.1, tack: 0.45, fuse: 0, weldBreak: 1.0, edgeMix: 0.003, weldMix: 0.05, weldLife: 0.0, viscoRelease: 10, creepTime: 0, shapeRate: 2.2, pushGain: 3 } },
];

export function getFeelPreset(id) {
  const preset = FEEL_PRESETS.find((entry) => entry.id === id);
  if (!preset) throw new Error(`Unknown feel preset: ${id}`);
  return preset;
}

const lerp = (a, b, t) => a + (b - a) * t;

function smoothstep(edge0, edge1, x) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * Slider values (0..1) → volumetric XPBD coefficients.
 *
 *   firmness  → tet-edge compliance (log-lerped; low = floppy, high = firm)
 *   recovery  → plastic edge flow rate; recovery 1 is fully elastic
 *   damping   → velocity damping and edge viscosity
 *   tack      → static slip threshold at the floor
 *   fuse      → whether a fold welds (0 = no fusion)
 *   weldBreak → stretch factor at which a weld snaps
 *   edgeMix   → kneading colour-streak rate along stretched edges
 *   weldMix   → colour-blend rate across welds (folded surfaces pressed together)
 *   weldLife  → seconds a temporary weld survives once the body is at rest
 *   viscoRelease → extra velocity damping applied only during recovery
 *
 * `recovery` drives `plasticRate`: it is 0 for an elastic preset and grows as
 * recovery drops so a plastic preset (slime) keeps its kneaded shape. The
 * global shape-matching memory is the separate `shapeRate` hidden key: 0 for a
 * plastic preset, small for a snappy one, larger for a soft one that must
 * unfold a deep knead within a few seconds even though the rate is ramped back
 * in after a gesture (v4 removed the old release-time boost).
 *
 * The simulation is a tetrahedral solid: edge and tet-volume constraints give
 * interior material that resists the tangential buckling a hollow shell suffers.
 */
export function resolvePhysics({ firmness: f, recovery: r, damping: d, tack, fuse, weldBreak, edgeMix, weldMix, weldLife, viscoRelease, creepTime, shapeRate, pushGain }) {
  const required = { tack, fuse, weldBreak, edgeMix, weldMix, weldLife, viscoRelease, creepTime, shapeRate, pushGain };
  const bad = Object.keys(required).filter((key) => !Number.isFinite(required[key]));
  if (bad.length > 0) {
    throw new Error(`resolvePhysics requires finite ${bad.join(', ')}`);
  }
  return {
    gravity: CONFIG.simulation.gravity,
    edgeCompliance: Math.exp(lerp(Math.log(0.134), Math.log(0.00201), f)),
    volumeCompliance: 0,
    plasticRate: 12 * (1 - smoothstep(0, 0.35, r)),
    plasticYield: 0.04,
    shapeRate,
    linearDamping: lerp(0.3, 6.0, d),
    viscosity: lerp(0.05, 0.35, d),
    grabStiffness: 1.0,
    floorFriction: CONFIG.simulation.floorFriction,
    freeFriction: CONFIG.simulation.freeFriction,
    staticFriction: CONFIG.simulation.staticFriction,
    tackBreak: tack,
    fuse,
    weldBreak,
    edgeMix,
    weldMix,
    weldLife,
    viscoRelease,
    creepTime,
    pushGain,
    skinSmoothIterations: 2,
  };
}
