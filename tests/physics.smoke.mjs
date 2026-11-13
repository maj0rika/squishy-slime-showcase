import { CONFIG } from '../src/config.js';
import { SoftBody } from '../src/physics/softBody.js';
import { buildTopology } from '../src/physics/topology.js';
import { tetrahedralize } from '../src/physics/tetrahedralize.js';
import { resolvePhysics, getFeelPreset } from '../src/physics/presets.js';

/**
 * Node-only smoke test for the volumetric XPBD soft body (round 5 + v3 mixing).
 *
 * No three.js: this file builds its own geodesic icosphere (each face split
 * into an n x n barycentric grid, shared vertices deduped by rounded
 * coordinates) so `node tests/physics.smoke.mjs` runs the exact solver the
 * browser runs. Two configs: (n = 24, spacing 0.14) and (n = 16, spacing 0.2).
 *
 * Metrics are sampled EVERY 1/60 s of every scenario over the WHOLE mesh (no
 * exclusions): flipped tetrahedra must stay 0, positions finite, and the
 * surface roughness of the SMOOTHED render surface (change of the
 * discrete-Laplacian magnitude)
 *   dev_i = | |pos_i - mean(nbr)| - |rest_i - mean(rest nbr)| | / meanRestEdge
 * must stay at roughP99 <= 0.15 and roughMax <= 0.45.
 *
 * Recovery is measured with shapeError(reference): the max distance between
 * the current surface and the reference (the settled surface) after the
 * best-fit rigid transform. It must be <= 0.08 three seconds after release.
 */

const H = CONFIG.simulation.fixedDt;
const FRAME = 1 / 60;
const SUBSTEPS = Math.round(FRAME / H);
const SQUISHY = getFeelPreset('squishy').values;
const SLOW = getFeelPreset('slow').values;
const SLIME = getFeelPreset('slime').values;
const BOUNCY = getFeelPreset('bouncy').values;

const ROUGH_P99_MAX = 0.15;
const ROUGH_MAX_MAX = 0.45;
const SHAPE_ERROR_MAX = 0.08;

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}: ${detail}`);
  }
}

/** Geodesic icosphere of frequency n. Vertex count must be 10n^2 + 2. */
function buildGeodesic(n) {
  const t = (1 + Math.sqrt(5)) / 2;
  const base = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => {
    const inv = 1 / Math.hypot(v[0], v[1], v[2]);
    return [v[0] * inv, v[1] * inv, v[2] * inv];
  });

  const baseFaces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  const verts = [];
  const lookup = new Map();
  const addVertex = (x, y, z) => {
    const key = `${Math.round(x * 1e6)}_${Math.round(y * 1e6)}_${Math.round(z * 1e6)}`;
    let index = lookup.get(key);
    if (index === undefined) {
      index = verts.length;
      verts.push([x, y, z]);
      lookup.set(key, index);
    }
    return index;
  };

  const faces = [];
  for (const [ia, ib, ic] of baseFaces) {
    const A = base[ia];
    const B = base[ib];
    const C = base[ic];
    const grid = [];
    for (let i = 0; i <= n; i++) {
      grid[i] = [];
      for (let j = 0; j <= n - i; j++) {
        const w0 = (n - i - j) / n;
        const w1 = i / n;
        const w2 = j / n;
        const x = A[0] * w0 + B[0] * w1 + C[0] * w2;
        const y = A[1] * w0 + B[1] * w1 + C[1] * w2;
        const z = A[2] * w0 + B[2] * w1 + C[2] * w2;
        const inv = 1 / Math.hypot(x, y, z);
        grid[i][j] = addVertex(x * inv, y * inv, z * inv);
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n - i; j++) {
        faces.push([grid[i][j], grid[i + 1][j], grid[i][j + 1]]);
        if (j < n - i - 1) {
          faces.push([grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]]);
        }
      }
    }
  }

  const expected = 10 * n * n + 2;
  if (verts.length !== expected) {
    throw new Error(`geodesic n=${n} produced ${verts.length} vertices, expected ${expected}`);
  }

  let minY = Infinity;
  for (const v of verts) {
    if (v[1] < -0.66) v[1] = -0.66;
    if (v[1] < minY) minY = v[1];
  }
  const lift = -minY;

  const rest = new Float32Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) {
    rest[i * 3] = verts[i][0];
    rest[i * 3 + 1] = verts[i][1] + lift;
    rest[i * 3 + 2] = verts[i][2];
  }

  const index = new Uint32Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    index[i * 3] = faces[i][0];
    index[i * 3 + 1] = faces[i][1];
    index[i * 3 + 2] = faces[i][2];
  }

  return { rest, index, vertexCount: verts.length };
}

function topVertex(body) {
  let best = -Infinity;
  let index = -1;
  for (let i = 0; i < body.count; i++) {
    if (body.pos[i * 3 + 1] > best) {
      best = body.pos[i * 3 + 1];
      index = i;
    }
  }
  return index;
}

function vertexPoint(body, i) {
  return { x: body.pos[i * 3], y: body.pos[i * 3 + 1], z: body.pos[i * 3 + 2] };
}

/** World normal at vertex i: the rest normal carried by the nearest frame R. */
function vertexNormal(body, i) {
  const rx = body.restNormals[i * 3];
  const ry = body.restNormals[i * 3 + 1];
  const rz = body.restNormals[i * 3 + 2];
  return { x: rx, y: ry, z: rz };
}

function width(body) {
  return body.bounds.maxX - body.bounds.minX;
}

function height(body) {
  return body.bounds.maxY - body.bounds.minY;
}

function finitePositions(body) {
  for (let i = 0; i < body.pos.length; i++) {
    if (!Number.isFinite(body.pos[i])) return false;
  }
  return true;
}

const lerp = (a, b, t) => a + (b - a) * t;

/** The mid-height (0.6 <= y <= 1.0) surface vertex with the extreme x. */
function midHeightExtreme(body, wantMaxX) {
  let best = wantMaxX ? -Infinity : Infinity;
  let index = -1;
  for (let i = 0; i < body.count; i++) {
    const y = body.pos[i * 3 + 1];
    const x = body.pos[i * 3];
    if (y >= 0.6 && y <= 1.0 && (wantMaxX ? x > best : x < best)) {
      best = x;
      index = i;
    }
  }
  if (index < 0) throw new Error('midHeightExtreme found no vertex with y in [0.6, 1.0]');
  return index;
}

/** Deterministic LCG for the fixed-seed colour kneading. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomTopVertex(body, rng) {
  const candidates = [];
  const cut = body.centroid.y;
  for (let i = 0; i < body.count; i++) {
    if (body.pos[i * 3 + 1] > cut) candidates.push(i);
  }
  if (candidates.length === 0) throw new Error('randomTopVertex found no upper vertex');
  return candidates[Math.floor(rng() * candidates.length) % candidates.length];
}

/**
 * One knead cycle: grab a random upper vertex, pull it up by `pullHeight` and
 * sideways by `dragX` over 0.25 s, release, then let the body relax for 0.25 s.
 * Advances the scenario 0.5 s per cycle.
 */
function kneadCycle(body, sc, rng, pullHeight, dragX) {
  const vi = randomTopVertex(body, rng);
  const p = vertexPoint(body, vi);
  const handle = body.beginGrab(p, CONFIG.grab.pull.radius);
  sc.advance(0.25, (t) => body.setGrabTarget(handle, p.x + dragX * t, p.y + pullHeight * t, p.z));
  body.endGrab(handle);
  sc.advance(0.25);
}

/**
 * Colour variance of the surface field: the mean of the per-channel variances
 * (each channel is centred on its own mean, so the between-channel spread of a
 * single body colour does not mask the marbling).
 */
function colorVariance(body) {
  const c = body.surfaceColor;
  const count = c.length / 3;
  const mean = [0, 0, 0];
  for (let i = 0; i < c.length; i++) mean[i % 3] += c[i];
  mean[0] /= count;
  mean[1] /= count;
  mean[2] /= count;
  const v = [0, 0, 0];
  for (let i = 0; i < c.length; i++) {
    const d = c[i] - mean[i % 3];
    v[i % 3] += d * d;
  }
  return (v[0] + v[1] + v[2]) / (3 * count);
}

function colorRange(body) {
  const c = body.surfaceColor;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < c.length; i++) {
    if (c[i] < lo) lo = c[i];
    if (c[i] > hi) hi = c[i];
  }
  return { lo, hi };
}

/**
 * Fold gesture: grab the max-x mid-height vertex, pull it out +1.2 in x, carry
 * it over the top of the body and press it down onto the far shoulder, hold,
 * then release. Used by the fusion / pass-through tests.
 */
function foldGesture(body, sc) {
  const gi = midHeightExtreme(body, true);
  const gp = vertexPoint(body, gi);
  const handle = body.beginGrab(gp, CONFIG.grab.pull.radius);
  const cx = body.centroid.x;
  const cz = body.centroid.z;
  const topY = body.bounds.maxY + 0.1;
  const endY = 0.5 * body.bounds.maxY;
  const overX = cx - 0.2;
  const startX = gp.x;
  const startY = gp.y;
  const startZ = gp.z;
  sc.advance(0.4, (t) => body.setGrabTarget(handle, startX + 1.2 * t, startY, startZ));
  const pulledX = startX + 1.2;
  sc.advance(0.4, (t) => body.setGrabTarget(handle, lerp(pulledX, overX, t), lerp(startY, topY, t), lerp(startZ, cz, t)));
  sc.advance(0.4, (t) => body.setGrabTarget(handle, overX, lerp(topY, endY, t), cz));
  sc.advance(0.4, () => body.setGrabTarget(handle, overX, endY, cz));
  body.endGrab(handle);
  return handle;
}

/** Collision pairs closer than 0.5 * collideDist but far apart in the material. */
function deepPairCount(body) {
  const { boundaryCount, boundaryNodes, nodePos, nodeRest, collideDist } = body;
  const restFar = CONFIG.knead.restFar * body.spacing;
  const restFarSq = restFar * restFar;
  const limSq = 0.25 * collideDist * collideDist;
  let count = 0;
  for (let a = 0; a < boundaryCount; a++) {
    const i = boundaryNodes[a];
    const i3 = i * 3;
    for (let b = a + 1; b < boundaryCount; b++) {
      const j = boundaryNodes[b];
      const j3 = j * 3;
      const dx = nodePos[j3] - nodePos[i3];
      const dy = nodePos[j3 + 1] - nodePos[i3 + 1];
      const dz = nodePos[j3 + 2] - nodePos[i3 + 2];
      if (dx * dx + dy * dy + dz * dz >= limSq) continue;
      const rx = nodeRest[j3] - nodeRest[i3];
      const ry = nodeRest[j3 + 1] - nodeRest[i3 + 1];
      const rz = nodeRest[j3 + 2] - nodeRest[i3 + 2];
      if (rx * rx + ry * ry + rz * rz <= restFarSq) continue;
      count += 1;
    }
  }
  return count;
}

/** Distance from `target` to the closest render-surface vertex. */
function nearestSurfaceDist(body, target) {
  let best = Infinity;
  for (let i = 0; i < body.count; i++) {
    const dx = body.pos[i * 3] - target.x;
    const dy = body.pos[i * 3 + 1] - target.y;
    const dz = body.pos[i * 3 + 2] - target.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/**
 * k upper-hemisphere surface vertices spread evenly in azimuth (one per
 * azimuth bin, the highest vertex in each bin). Deterministic.
 */
function upperHemisphereHands(body, k) {
  const bins = new Array(k).fill(-1);
  const binY = new Array(k).fill(-Infinity);
  for (let i = 0; i < body.count; i++) {
    const y = body.pos[i * 3 + 1];
    if (y <= 0.35) continue;
    let a = Math.atan2(body.pos[i * 3 + 2], body.pos[i * 3]);
    if (a < 0) a += Math.PI * 2;
    const bin = Math.min(k - 1, Math.floor((a / (Math.PI * 2)) * k));
    if (y > binY[bin]) {
      binY[bin] = y;
      bins[bin] = i;
    }
  }
  const out = [];
  for (let b = 0; b < k; b++) if (bins[b] >= 0) out.push(bins[b]);
  if (out.length < k) throw new Error(`upperHemisphereHands found ${out.length} of ${k} vertices`);
  return out;
}

const CURVE_SETTLE = 2.0;

/**
 * Area-weighted current surface normal at vertex `vi` (the face normal the
 * browser uses for the grab dent), computed from the live `body.pos`.
 */
function surfaceNormalAt(body, vi) {
  const tris = body.topo.tris;
  const pos = body.pos;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t];
    const b = tris[t + 1];
    const c = tris[t + 2];
    if (a !== vi && b !== vi && c !== vi) continue;
    const a3 = a * 3;
    const b3 = b * 3;
    const c3 = c * 3;
    const abx = pos[b3] - pos[a3];
    const aby = pos[b3 + 1] - pos[a3 + 1];
    const abz = pos[b3 + 2] - pos[a3 + 2];
    const acx = pos[c3] - pos[a3];
    const acy = pos[c3 + 1] - pos[a3 + 1];
    const acz = pos[c3 + 2] - pos[a3 + 2];
    nx += aby * acz - abz * acy;
    ny += abz * acx - abx * acz;
    nz += abx * acy - aby * acx;
  }
  const inv = 1 / Math.max(Math.hypot(nx, ny, nz), 1e-12);
  return { x: nx * inv, y: ny * inv, z: nz * inv };
}

/**
 * Five camera-facing upper surface vertices spread around the frontal cone
 * (direction from the centroid within 60 degrees of (0, 0.4, 1)). Candidates are
 * sorted by their screen-plane azimuth (z projected out) and sampled evenly, so
 * the five hands land on top-front / front-left / front-right / upper-left /
 * upper-right like the five real fingers. Deterministic.
 */
function frontUpperHands(body, k) {
  const cx = body.centroid.x;
  const cy = body.centroid.y;
  const cz = body.centroid.z;
  const fx = 0;
  const fy = 0.4;
  const fz = 1;
  const flen = Math.hypot(fx, fy, fz);
  const cand = [];
  for (let i = 0; i < body.count; i++) {
    const y = body.pos[i * 3 + 1];
    if (y <= cy) continue;
    const dx = body.pos[i * 3] - cx;
    const dy = y - cy;
    const dz = body.pos[i * 3 + 2] - cz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) continue;
    if ((dx * fx + dy * fy + dz * fz) / (len * flen) < 0.5) continue;
    cand.push({ i, ang: Math.atan2(dy, dx) });
  }
  if (cand.length < k) throw new Error(`frontUpperHands found ${cand.length} of ${k} vertices`);
  cand.sort((a, b) => a.ang - b.ang);
  const out = [];
  for (let b = 0; b < k; b++) out.push(cand[Math.floor(((b + 0.5) / k) * cand.length)].i);
  return out;
}

/** Step the body one 1/60 s frame (all substeps + derived update). */
function stepFrame(body) {
  for (let s = 0; s < SUBSTEPS; s++) body.step(H);
  body.updateDerived(FRAME);
}

/**
 * Cheap per-frame collapse metric: the total signed tet volume ratio and the
 * number of inverted tets, in a single tet pass (no roughness sort, unlike
 * body.stats()). Used by the long stress test so sampling stays affordable.
 */
function volumeFlip(body) {
  const { tets, tetCount, nodePos, totalRestVolume } = body;
  let volume = 0;
  let flipped = 0;
  for (let t = 0; t < tetCount; t++) {
    const b = t * 4;
    const i0 = tets[b] * 3;
    const i1 = tets[b + 1] * 3;
    const i2 = tets[b + 2] * 3;
    const i3 = tets[b + 3] * 3;
    const ax = nodePos[i0];
    const ay = nodePos[i0 + 1];
    const az = nodePos[i0 + 2];
    const e1x = nodePos[i1] - ax;
    const e1y = nodePos[i1 + 1] - ay;
    const e1z = nodePos[i1 + 2] - az;
    const e2x = nodePos[i2] - ax;
    const e2y = nodePos[i2 + 1] - ay;
    const e2z = nodePos[i2 + 2] - az;
    const e3x = nodePos[i3] - ax;
    const e3y = nodePos[i3 + 1] - ay;
    const e3z = nodePos[i3 + 2] - az;
    const det = e1x * (e2y * e3z - e2z * e3y) + e1y * (e2z * e3x - e2x * e3z) + e1z * (e2x * e3y - e2y * e3x);
    volume += det / 6;
    if (det <= 0) flipped += 1;
  }
  return { volumeRatio: volume / totalRestVolume, flipped };
}

/**
 * A12 press-crush: palm at the centroid pressed down to the crush floor
 * (floorY + body.pressMinThickness) over 0.4 s, held 2 s while the palm centre
 * smears ±0.3 in x, released, then 3 s of recovery. Asserts the total volume
 * never drops below 0.85, the inverted fraction stays ≤ 0.5 % at every sample
 * and reaches 0 at the end.
 */
function pressCrush(body, preset, label) {
  body.setParams(resolvePhysics(preset));
  body.reset({ drop: false });
  const settleSc = new Scenario(`${label}-settle`, body, { checkRoughness: false });
  settleSc.advance(2.0);
  settleSc.report();
  const cx = body.centroid.x;
  const cz = body.centroid.z;
  const pressY = body.floorY + body.pressMinThickness;
  const radius = CONFIG.grab.press.radius;
  const top = body.topHeightAt(cx, cz, radius);
  body.beginPress(cx, cz, top, radius);

  let minVol = Infinity;
  let maxFlipFrac = 0;
  let nonFinite = false;
  const sample = () => {
    if (!finitePositions(body)) nonFinite = true;
    const q = volumeFlip(body);
    if (q.volumeRatio < minVol) minVol = q.volumeRatio;
    const frac = q.flipped / body.tetCount;
    if (frac > maxFlipFrac) maxFlipFrac = frac;
  };

  const down = Math.round(0.4 / FRAME);
  for (let f = 0; f < down; f++) {
    const t = (f + 1) / down;
    body.setPress(cx, cz, top + (pressY - top) * t);
    stepFrame(body);
    sample();
  }
  const hold = Math.round(2.0 / FRAME);
  for (let f = 0; f < hold; f++) {
    const t = (f + 1) / hold;
    body.setPress(cx + 0.3 * Math.sin(t * Math.PI * 2), cz, pressY);
    stepFrame(body);
    sample();
  }
  body.endPress();
  const rel = Math.round(3.0 / FRAME);
  for (let f = 0; f < rel; f++) {
    stepFrame(body);
    sample();
  }

  const finalFlipped = body.countFlipped();
  console.log(
    `  ${label}: minVolumeRatio=${minVol.toFixed(4)} maxFlipFrac=${(maxFlipFrac * 100).toFixed(3)}% ` +
      `finalFlipped=${finalFlipped} finite=${!nonFinite} pressMinThickness=${body.pressMinThickness.toFixed(3)}`
  );
  check(`${label} volumeRatio >= 0.85 at every sample`, minVol >= 0.85, `minVolumeRatio=${minVol.toFixed(4)}`);
  check(`${label} inverted <= 0.5% of tets`, maxFlipFrac <= 0.005, `maxFlipFrac=${(maxFlipFrac * 100).toFixed(3)}%`);
  check(`${label} inverted === 0 at the end`, finalFlipped === 0, `finalFlipped=${finalFlipped}`);
  check(`${label} finite positions`, !nonFinite, 'non-finite position during press-crush');
}

/**
 * A12 stress-random: a seeded 80-gesture stress mirroring the browser mix
 * (3/7 pulls incl. extreme off-target drags, 1/7 deep palm presses, 1/7 preset
 * switches among the four presets, 1/7 folds, 1/7 idle, plus a drop and a poke
 * every 10 gestures). Samples volumeRatio and inversion every 1/60 s; the body
 * must never collapse below 0.85, must stay finite, and must end with zero
 * inverted tets 2 s after the last gesture.
 */
function stressRandom(body, label) {
  const rng = makeRng(20261110);
  const presetList = [SQUISHY, SLOW, SLIME, BOUNCY];
  const pullRadius = CONFIG.grab.pull.radius;
  const pressRadius = CONFIG.grab.press.radius;
  const maxDrag = CONFIG.grab.pull.maxDrag;
  const pressY = body.floorY + body.pressMinThickness;

  let minVol = Infinity;
  let maxFlipFrac = 0;
  let nonFinite = false;
  let worst = { vol: Infinity, gesture: -1, frame: -1 };
  let frameIndex = 0;

  const sample = (gesture) => {
    frameIndex += 1;
    if (!finitePositions(body)) nonFinite = true;
    const q = volumeFlip(body);
    if (q.volumeRatio < minVol) {
      minVol = q.volumeRatio;
      worst = { vol: q.volumeRatio, gesture, frame: frameIndex };
    }
    const frac = q.flipped / body.tetCount;
    if (frac > maxFlipFrac) maxFlipFrac = frac;
  };
  const frames = (seconds, onFrame, gesture) => {
    const n = Math.max(1, Math.round(seconds / FRAME));
    for (let f = 0; f < n; f++) {
      if (onFrame) onFrame((f + 1) / n);
      for (let s = 0; s < SUBSTEPS; s++) body.step(H);
      body.updateDerived(FRAME);
      sample(gesture);
    }
  };

  body.setParams(resolvePhysics(SQUISHY));
  body.reset({ drop: false });
  frames(2.0, null, -1);

  const GESTURES = 80;
  for (let g = 0; g < GESTURES; g++) {
    const kind = g % 7;
    if (kind <= 2) {
      // pull, incl. off-target extreme drags up to maxDrag
      const vi = randomTopVertex(body, rng);
      const p = vertexPoint(body, vi);
      const handle = body.beginGrab(p, pullRadius);
      const ang = rng() * Math.PI * 2;
      const drag = 0.4 + rng() * (maxDrag - 0.4);
      const dx = Math.cos(ang) * drag;
      const dz = Math.sin(ang) * drag;
      const dy = (rng() - 0.35) * 0.9;
      frames(0.3, (t) => body.setGrabTarget(handle, p.x + dx * t, p.y + dy * t, p.z + dz * t), g);
      frames(0.3, null, g);
      body.endGrab(handle);
      frames(0.2, null, g);
    } else if (kind === 3) {
      // deep palm press to the crush floor
      const px = body.centroid.x + (rng() - 0.5) * 0.4;
      const pz = body.centroid.z + (rng() - 0.5) * 0.4;
      const top = body.topHeightAt(px, pz, pressRadius);
      body.beginPress(px, pz, top, pressRadius);
      frames(0.3, (t) => body.setPress(px, pz, top + (pressY - top) * t), g);
      frames(0.6, () => body.setPress(px, pz, pressY), g);
      body.endPress();
      frames(0.3, null, g);
    } else if (kind === 4) {
      // preset switch among the four presets (incl. slime)
      const preset = presetList[Math.floor(rng() * presetList.length) % presetList.length];
      body.setParams(resolvePhysics(preset));
      frames(0.1, null, g);
    } else if (kind === 5) {
      // fold gesture: grab a random upper vertex, carry it over the top and
      // press it down on the far shoulder (a robust pick that does not assume a
      // fixed mid-height band, unlike foldGesture)
      const vi = randomTopVertex(body, rng);
      const gp = vertexPoint(body, vi);
      const handle = body.beginGrab(gp, pullRadius);
      const cx = body.centroid.x;
      const cz = body.centroid.z;
      const topY = body.bounds.maxY + 0.1;
      const endY = 0.5 * body.bounds.maxY;
      const overX = cx - 0.2;
      frames(0.4, (t) => body.setGrabTarget(handle, gp.x + 1.2 * t, gp.y, gp.z), g);
      const pulledX = gp.x + 1.2;
      frames(0.4, (t) => body.setGrabTarget(handle, lerp(pulledX, overX, t), lerp(gp.y, topY, t), lerp(gp.z, cz, t)), g);
      frames(0.4, (t) => body.setGrabTarget(handle, overX, lerp(topY, endY, t), cz), g);
      frames(0.4, () => body.setGrabTarget(handle, overX, endY, cz), g);
      body.endGrab(handle);
      frames(0.4, null, g);
    } else {
      frames(0.4, null, g);
    }

    if (g % 10 === 9) {
      body.drop(CONFIG.simulation.dropHeight);
      frames(0.5, null, g);
      const vi = randomTopVertex(body, rng);
      const p = vertexPoint(body, vi);
      const nrm = surfaceNormalAt(body, vi);
      body.pokeAt(p, nrm, 1.6);
      frames(0.4, null, g);
    }
  }

  frames(2.0, null, -1);
  const finalFlipped = body.countFlipped();
  console.log(
    `  ${label}: minVolumeRatio=${minVol.toFixed(4)} (gesture ${worst.gesture}, frame ${worst.frame}) ` +
      `maxFlipFrac=${(maxFlipFrac * 100).toFixed(3)}% finalFlipped=${finalFlipped} finite=${!nonFinite}`
  );
  check(`${label} volumeRatio >= 0.85 at every sample`, minVol >= 0.85, `minVolumeRatio=${minVol.toFixed(4)}`);
  check(`${label} finite positions`, !nonFinite, 'non-finite position during stress');
  check(`${label} inverted === 0 after settle`, finalFlipped === 0, `finalFlipped=${finalFlipped}`);
}

/**
 * Release curve: settle, pull the top +1.0 y over 0.4 s, hold 0.5 s, release,
 * then sample maxY every frame for 5 s. Returns D0, t50, under (dip below the
 * settled height / D0) and settle (last time outside the 1 % band).
 */
function releaseCurve(body, preset, label) {  body.setParams(resolvePhysics(preset));
  body.reset({ drop: false });
  const settleSc = new Scenario(`${label}-settle`, body);
  settleSc.advance(CURVE_SETTLE);
  settleSc.report();
  const settled = body.bounds.maxY;
  const gi = topVertex(body);
  const gp = vertexPoint(body, gi);
  const handle = body.beginGrab(gp, CONFIG.grab.pull.radius);
  const sc = new Scenario(label, body, { checkRoughness: false });
  sc.advance(0.4, (t) => body.setGrabTarget(handle, gp.x, gp.y + 1.0 * t, gp.z));
  sc.advance(0.5);
  const D0 = body.bounds.maxY - settled;
  body.endGrab(handle);
  const N = Math.round(5.0 / FRAME);
  const maxY = new Float64Array(N);
  for (let f = 0; f < N; f++) {
    for (let s = 0; s < SUBSTEPS; s++) body.step(H);
    body.updateDerived(FRAME);
    maxY[f] = body.bounds.maxY;
  }
  const metrics = curveMetrics(maxY, settled, D0, 'release');
  console.log(
    `  ${label}: settled=${settled.toFixed(3)} D0=${D0.toFixed(3)} t50=${fmt(metrics.t50)} ` +
      `under=${metrics.under.toFixed(4)} settle=${metrics.settle.toFixed(3)} finite=${finitePositions(body)}`
  );
  check(`${label} finite positions`, finitePositions(body), 'non-finite after release');
  sc.report();
  return metrics;
}

/**
 * Press curve: settle, palm-press the top to 0.6·settled over 0.4 s, hold 0.6 s,
 * release, then sample maxY every frame for 5 s. Same metrics as the release
 * curve, computed on maxY rising back.
 */
function pressCurve(body, preset, label) {
  body.setParams(resolvePhysics(preset));
  body.reset({ drop: false });
  const settleSc = new Scenario(`${label}-settle`, body);
  settleSc.advance(CURVE_SETTLE);
  settleSc.report();
  const settled = body.bounds.maxY;
  const x = body.centroid.x;
  const z = body.centroid.z;
  const top = body.topHeightAt(x, z, CONFIG.grab.press.radius);
  body.beginPress(x, z, top, CONFIG.grab.press.radius);
  const sc = new Scenario(label, body, { checkRoughness: false });
  sc.advance(0.4, (t) => body.setPress(x, z, top + (0.6 * settled - top) * t));
  sc.advance(0.6);
  const D0 = settled - body.bounds.maxY;
  body.endPress();
  const N = Math.round(5.0 / FRAME);
  const maxY = new Float64Array(N);
  for (let f = 0; f < N; f++) {
    for (let s = 0; s < SUBSTEPS; s++) body.step(H);
    body.updateDerived(FRAME);
    maxY[f] = body.bounds.maxY;
  }
  const metrics = curveMetrics(maxY, settled, D0, 'press');
  console.log(
    `  ${label}: settled=${settled.toFixed(3)} D0=${D0.toFixed(3)} t50=${fmt(metrics.t50)} ` +
      `under=${metrics.under.toFixed(4)} settle=${metrics.settle.toFixed(3)} finite=${finitePositions(body)}`
  );
  check(`${label} finite positions`, finitePositions(body), 'non-finite after release');
  sc.report();
  return metrics;
}

const fmt = (v) => (Number.isFinite(v) ? v.toFixed(3) : 'inf');

function curveMetrics(maxY, settled, D0, kind) {
  const N = maxY.length;
  let t50 = Infinity;
  for (let f = 0; f < N; f++) {
    const reached = kind === 'release' ? maxY[f] - settled <= 0.5 * D0 : settled - maxY[f] <= 0.5 * D0;
    if (reached) {
      t50 = (f + 1) * FRAME;
      break;
    }
  }
  let under = 0;
  for (let f = 0; f < N; f++) {
    const u = kind === 'release' ? (settled - maxY[f]) / D0 : (maxY[f] - settled) / D0;
    if (u > under) under = u;
  }
  let lastOut = -1;
  for (let f = 0; f < N; f++) {
    if (Math.abs(maxY[f] - settled) > 0.01 * settled) lastOut = f;
  }
  return { t50, under, settle: (lastOut + 1) * FRAME };
}

/** Assert a release/press curve against a preset's t50/under/settle windows. */
function checkCurve(label, metrics, { t50Min, t50Max, underMax, underMin = 0, settleMax }) {
  check(
    `${label} t50 in [${t50Min}, ${t50Max}]`,
    metrics.t50 >= t50Min && metrics.t50 <= t50Max,
    `t50=${fmt(metrics.t50)}`
  );
  check(
    `${label} under in [${underMin}, ${underMax}]`,
    metrics.under >= underMin && metrics.under <= underMax,
    `under=${metrics.under.toFixed(4)}`
  );
  check(`${label} settle <= ${settleMax}`, metrics.settle <= settleMax, `settle=${metrics.settle.toFixed(3)}`);
}

/**
 * Frame-accurate scenario runner. Steps `seconds` of physics in 1/60 s frames
 * and samples the whole-mesh invariants at every frame, remembering the worst
 * values so a scenario can report a single line.
 */
class Scenario {
  constructor(name, body, { checkRoughness = true } = {}) {
    this.name = name;
    this.body = body;
    this.checkRoughness = checkRoughness;
    this.flips = 0;
    this.roughP99 = 0;
    this.roughMax = 0;
    this.nonFinite = 0;
    this.firstBad = null;
  }

  advance(seconds, onFrame) {
    const frames = Math.round(seconds / FRAME);
    for (let f = 0; f < frames; f++) {
      if (onFrame) onFrame((f + 1) / frames);
      for (let s = 0; s < SUBSTEPS; s++) this.body.step(H);
      this.body.updateDerived(FRAME);
      this.sample((f + 1) / frames);
    }
  }

  sample(t) {
    const stats = this.body.stats();
    if (stats.flipped > 0) {
      this.flips += 1;
      if (!this.firstBad) this.firstBad = { t, why: `flipped=${stats.flipped}` };
    }
    if (!finitePositions(this.body)) {
      this.nonFinite += 1;
      if (!this.firstBad) this.firstBad = { t, why: 'non-finite position' };
    }
    if (stats.roughP99 > this.roughP99) this.roughP99 = stats.roughP99;
    if (stats.roughMax > this.roughMax) this.roughMax = stats.roughMax;
  }

  report() {
    console.log(
      `  ${this.name}: roughP99=${this.roughP99.toFixed(4)} roughMax=${this.roughMax.toFixed(4)} ` +
        `flippedFrames=${this.flips} nonFiniteFrames=${this.nonFinite}`
    );
    check(`${this.name} flipped === 0`, this.flips === 0, `first bad ${JSON.stringify(this.firstBad)}`);
    check(`${this.name} finite positions`, this.nonFinite === 0, `first bad ${JSON.stringify(this.firstBad)}`);
    if (this.checkRoughness) {
      check(`${this.name} roughP99 <= ${ROUGH_P99_MAX}`, this.roughP99 <= ROUGH_P99_MAX, `roughP99=${this.roughP99.toFixed(4)}`);
      check(`${this.name} roughMax <= ${ROUGH_MAX_MAX}`, this.roughMax <= ROUGH_MAX_MAX, `roughMax=${this.roughMax.toFixed(4)}`);
    }
  }
}

function runConfig(n, spacing) {
  const mesh = buildGeodesic(n);
  console.log(`\n=== n=${n} spacing=${spacing} (${mesh.vertexCount} surface verts, ${mesh.index.length / 3} tris) ===`);

  // 1. tetrahedralize
  const tet = tetrahedralize({ surfacePos: mesh.rest, index: mesh.index, spacing });
  console.log(
    `tetra: nodes=${tet.nodeCount} tets=${tet.tetCount} edges=${tet.edgeCount}`
  );
  let minRestVol = Infinity;
  for (let t = 0; t < tet.tetCount; t++) if (tet.restVol[t] < minRestVol) minRestVol = tet.restVol[t];
  check('tetra all restVol > 0', minRestVol > 0, `min restVol=${minRestVol}`);
  const topo = buildTopology(mesh.index, mesh.vertexCount);
  check(
    'surface topology valid',
    topo.edgeCount === 30 * n * n && topo.triCount === 20 * n * n,
    `edgeCount=${topo.edgeCount} triCount=${topo.triCount}`
  );

  const body = new SoftBody({ rest: mesh.rest, index: mesh.index, floorY: 0, spacing });
  console.log(
    `body: boundaryCount=${body.boundaryCount} spacing=${body.spacing} collideDist=${body.collideDist.toFixed(4)}`
  );

  const reset = (values) => {
    body.setParams(resolvePhysics(values));
    body.reset({ drop: false });
  };
  const settle = (name) => {
    const sc = new Scenario(`${name}-settle`, body);
    sc.advance(2.0);
    sc.report();
    return sc;
  };
  const capture = () => Float32Array.from(body.pos);
  const checkShape = (name, reference) => {
    const err = body.shapeError(reference);
    console.log(`  ${name} shapeError=${err.toFixed(4)}`);
    check(`${name} shapeError <= ${SHAPE_ERROR_MAX}`, err <= SHAPE_ERROR_MAX, `shapeError=${err.toFixed(4)}`);
  };

  // 2. settle
  {
    reset(SQUISHY);
    const sc = settle('settle');
    const stats = body.stats();
    const restHeight = height(body);
    console.log(
      `settle: volumeRatio=${stats.volumeRatio.toFixed(4)} height=${restHeight.toFixed(3)} ` +
        `contact.count=${body.contact.count} contactRadius=${body.contact.radius.toFixed(3)}`
    );
    check('settle volumeRatio in [0.97, 1.03]', stats.volumeRatio >= 0.97 && stats.volumeRatio <= 1.03, `volumeRatio=${stats.volumeRatio}`);
    check('settle height >= 0.85 x rest height', restHeight >= 0.85 * 1.66, `height=${restHeight.toFixed(3)}`);
    check('settle contact.count > 0', body.contact.count > 0, `count=${body.contact.count}`);
  }

  // 3. pull-small: +1.0 y over 0.5 s, hold 1 s, release + 3 s
  {
    reset(SQUISHY);
    settle('pull-small');
    const reference = capture();
    const settledHeight = height(body);
    const settledWidth = width(body);
    const baseMaxY = body.bounds.maxY;
    const gi = topVertex(body);
    const gp = vertexPoint(body, gi);
    const handle = body.beginGrab(gp, CONFIG.grab.pull.radius);
    const sc = new Scenario('pull-small', body);
    sc.advance(0.5, (t) => body.setGrabTarget(handle, gp.x, gp.y + 1.0 * t, gp.z));
    sc.advance(1.0);
    const stats = body.stats();
    const rise = body.bounds.maxY - baseMaxY;
    console.log(
      `pull-small: rise=${rise.toFixed(3)} lifted=${stats.lifted} maxStretch=${stats.maxStretch.toFixed(3)} ` +
        `heightRatio=${(height(body) / settledHeight).toFixed(3)} widthRatio=${(width(body) / settledWidth).toFixed(3)}`
    );
    check('pull-small lifted === false', stats.lifted === false, `lifted=${stats.lifted}`);
    check('pull-small rise >= 0.75', rise >= 0.75, `rise=${rise.toFixed(3)}`);
    check('pull-small maxStretch >= 1.25', stats.maxStretch >= 1.25, `maxStretch=${stats.maxStretch.toFixed(3)}`);
    check('pull-small height/width >= 1.3x settled', height(body) / width(body) >= 1.3 * (settledHeight / settledWidth), `ratio=${(height(body) / width(body)).toFixed(3)} settled=${(settledHeight / settledWidth).toFixed(3)}`);
    sc.report();

    body.endGrab(handle);
    const rel = new Scenario('pull-small-release', body);
    rel.advance(3.0);
    rel.report();
    checkShape('pull-small-release', reference);
  }

  // 4 + 5. hang, then drop-splat and recovery
  {
    reset(SQUISHY);
    settle('hang');
    const reference = capture();
    const settledHeight = height(body);
    const settledContact = body.contact.radius;
    const gi = topVertex(body);
    const gp = vertexPoint(body, gi);
    const handle = body.beginGrab(gp, CONFIG.grab.pull.radius);
    const sc = new Scenario('hang', body);
    sc.advance(0.6, (t) => body.setGrabTarget(handle, gp.x, gp.y + 2.4 * t, gp.z));
    sc.advance(1.5);
    const stats = body.stats();
    console.log(`hang: maxY=${body.bounds.maxY.toFixed(3)} lifted=${stats.lifted} heightRatio=${(height(body) / settledHeight).toFixed(3)}`);
    check('hang lifted === true', stats.lifted === true, `lifted=${stats.lifted}`);
    check('hang height >= 1.15x settled', height(body) >= 1.15 * settledHeight, `heightRatio=${(height(body) / settledHeight).toFixed(3)}`);
    sc.report();

    // drop-splat after release
    body.endGrab(handle);
    const drop = new Scenario('drop-splat', body);
    let maxContact = 0;
    drop.advance(0.6, () => {
      if (body.contact.radius > maxContact) maxContact = body.contact.radius;
    });
    drop.advance(2.4);
    console.log(
      `drop-splat: maxContact=${maxContact.toFixed(3)} settled=${settledContact.toFixed(3)} ` +
        `ratio=${(maxContact / settledContact).toFixed(3)}`
    );
    check('drop-splat max contact.radius >= 1.12x settled', maxContact >= 1.12 * settledContact, `ratio=${(maxContact / settledContact).toFixed(3)}`);
    drop.report();
    checkShape('drop-splat', reference);
  }

  // 6. off-centre press
  {
    reset(SQUISHY);
    settle('press');
    const reference = capture();
    const settledContact = body.contact.radius;
    const x = body.centroid.x + 0.15;
    const z = body.centroid.z + 0.45;
    const top = body.topHeightAt(x, z, CONFIG.grab.press.radius);
    body.beginPress(x, z, top, CONFIG.grab.press.radius);
    const sc = new Scenario('press', body);
    sc.advance(0.5, (t) => body.setPress(x, z, top + (0.6 - top) * t));
    sc.advance(0.9);
    const stats = body.stats();
    console.log(
      `press: contactRadius=${stats.contactRadius.toFixed(3)} settled=${settledContact.toFixed(3)} ` +
        `ratio=${(stats.contactRadius / settledContact).toFixed(3)} volumeRatio=${stats.volumeRatio.toFixed(4)}`
    );
    check('press contact.radius >= 1.25x settled', stats.contactRadius >= 1.25 * settledContact, `ratio=${(stats.contactRadius / settledContact).toFixed(3)}`);
    check('press volumeRatio >= 0.9', stats.volumeRatio >= 0.9, `volumeRatio=${stats.volumeRatio.toFixed(4)}`);
    sc.report();

    body.endPress();
    const rel = new Scenario('press-release', body);
    rel.advance(3.0);
    rel.report();
    checkShape('press-release', reference);
  }

  // 7. diagonal side pull
  {
    reset(SQUISHY);
    settle('side-pull');
    const reference = capture();
    const settledWidth = width(body);
    const settledContactX = body.contact.x;
    const gi = midHeightExtreme(body, true);
    const gp = vertexPoint(body, gi);
    const handle = body.beginGrab(gp, CONFIG.grab.pull.radius);
    const sc = new Scenario('side-pull', body);
    sc.advance(0.5, (t) => body.setGrabTarget(handle, gp.x + 1.4 * t, gp.y + 0.25 * t, gp.z));
    sc.advance(0.6);
    console.log(
      `side-pull: width=${width(body).toFixed(3)} settled=${settledWidth.toFixed(3)} ` +
        `ratio=${(width(body) / settledWidth).toFixed(3)} contactShift=${Math.abs(body.contact.x - settledContactX).toFixed(3)}`
    );
    check('side-pull width >= 1.3x settled', width(body) >= 1.3 * settledWidth, `ratio=${(width(body) / settledWidth).toFixed(3)}`);
    check('side-pull contact.x shift <= 0.3', Math.abs(body.contact.x - settledContactX) <= 0.3, `shift=${Math.abs(body.contact.x - settledContactX).toFixed(3)}`);
    sc.report();

    body.endGrab(handle);
    const rel = new Scenario('side-pull-release', body);
    rel.advance(3.0);
    rel.report();
    checkShape('side-pull-release', reference);
  }

  // 8. front pull with dent
  {
    reset(SQUISHY);
    settle('front-pull');
    const reference = capture();
    const baseMaxY = body.bounds.maxY;
    let gi = -1;
    let best = -Infinity;
    for (let i = 0; i < body.count; i++) {
      const score = body.pos[i * 3 + 1] + 0.6 * body.pos[i * 3 + 2];
      if (score > best) {
        best = score;
        gi = i;
      }
    }
    const gp = vertexPoint(body, gi);
    const nrm = vertexNormal(body, gi);
    const dented = { x: gp.x - nrm.x * 0.16, y: gp.y - nrm.y * 0.16, z: gp.z - nrm.z * 0.16 };
    const target = { x: gp.x + 0.25, y: gp.y + 1.2, z: gp.z };
    const handle = body.beginGrab(gp, CONFIG.grab.pull.radius);
    const sc = new Scenario('front-pull', body);
    sc.advance(0.15, () => body.setGrabTarget(handle, dented.x, dented.y, dented.z));
    sc.advance(0.4, (t) => body.setGrabTarget(handle, lerp(dented.x, target.x, t), lerp(dented.y, target.y, t), lerp(dented.z, target.z, t)));
    sc.advance(0.6);
    const stats = body.stats();
    const rise = body.bounds.maxY - baseMaxY;
    console.log(`front-pull: rise=${rise.toFixed(3)} lifted=${stats.lifted} maxStretch=${stats.maxStretch.toFixed(3)}`);
    check('front-pull lifted === false', stats.lifted === false, `lifted=${stats.lifted}`);
    check('front-pull rise >= 0.8', rise >= 0.8, `rise=${rise.toFixed(3)}`);
    sc.report();

    body.endGrab(handle);
    const rel = new Scenario('front-pull-release', body);
    rel.advance(3.0);
    rel.report();
    checkShape('front-pull-release', reference);
  }

  // 9. slime plastic memory: pull up 1.2, release, 2 s
  {
    reset(SLIME);
    settle('slime');
    const slimeSettledMaxY = body.bounds.maxY;
    const gi = topVertex(body);
    const gp = vertexPoint(body, gi);
    const handle = body.beginGrab(gp, CONFIG.grab.pull.radius);
    const sc = new Scenario('slime', body);
    sc.advance(0.5, (t) => body.setGrabTarget(handle, gp.x, gp.y + 1.2 * t, gp.z));
    body.endGrab(handle);
    sc.advance(2.0);
    const kept = body.bounds.maxY - slimeSettledMaxY;
    console.log(`slime: settledMaxY=${slimeSettledMaxY.toFixed(3)} finalMaxY=${body.bounds.maxY.toFixed(3)} kept=${kept.toFixed(3)}`);
    check('slime keeps maxY >= settled + 0.3', kept >= 0.3, `kept=${kept.toFixed(3)}`);
    sc.report();
  }

  // 10. drop(1.1) from rest
  {
    reset(SQUISHY);
    settle('drop-action');
    const reference = capture();
    const settledContact = body.contact.radius;
    body.drop(CONFIG.simulation.dropHeight);
    const sc = new Scenario('drop-action', body);
    let maxContact = 0;
    sc.advance(0.6, () => {
      if (body.contact.radius > maxContact) maxContact = body.contact.radius;
    });
    sc.advance(2.4);
    console.log(
      `drop-action: maxContact=${maxContact.toFixed(3)} settled=${settledContact.toFixed(3)} ` +
        `ratio=${(maxContact / settledContact).toFixed(3)}`
    );
    check('drop-action max contact.radius >= 1.12x settled', maxContact >= 1.12 * settledContact, `ratio=${(maxContact / settledContact).toFixed(3)}`);
    sc.report();
    checkShape('drop-action', reference);
  }

  // 11. flick-release: fast lateral flick (+2.0 x in 0.05 s) then immediate release
  {
    reset(SQUISHY);
    settle('flick');
    const gi = midHeightExtreme(body, true);
    const gp = vertexPoint(body, gi);
    const handle = body.beginGrab(gp, CONFIG.grab.pull.radius);
    const sc = new Scenario('flick-release', body);
    sc.advance(0.05, (t) => body.setGrabTarget(handle, gp.x + 2.0 * t, gp.y, gp.z));
    body.endGrab(handle);
    sc.advance(2.0);
    console.log(
      `flick-release: maxX=${body.bounds.maxX.toFixed(3)} roughP99=${sc.roughP99.toFixed(4)} ` +
        `roughMax=${sc.roughMax.toFixed(4)} flippedFrames=${sc.flips} nonFiniteFrames=${sc.nonFinite}`
    );
    check('flick-release flipped === 0', sc.flips === 0, `first bad ${JSON.stringify(sc.firstBad)}`);
    check('flick-release finite positions', sc.nonFinite === 0, `first bad ${JSON.stringify(sc.firstBad)}`);
  }

  // A7.1 fold-fuse (slime): the folded patch fuses into welds that persist.
  {
    reset(SLIME);
    settle('fold-fuse');
    const sc = new Scenario('fold-fuse', body, { checkRoughness: false });
    foldGesture(body, sc);
    sc.advance(1.5);
    const stats = body.stats();
    let maxRatio = 0;
    const sample = Math.min(20, body.weldCount);
    for (let w = 0; w < sample; w++) {
      const i3 = body.weldA[w] * 3;
      const j3 = body.weldB[w] * 3;
      const length = Math.hypot(
        body.nodePos[j3] - body.nodePos[i3],
        body.nodePos[j3 + 1] - body.nodePos[i3 + 1],
        body.nodePos[j3 + 2] - body.nodePos[i3 + 2]
      );
      const ratio = length / body.weldRest[w];
      if (ratio > maxRatio) maxRatio = ratio;
    }
    console.log(
      `fold-fuse: welds=${stats.welds} collisions=${stats.collisions} sampled=${sample} maxWeldRatio=${maxRatio.toFixed(3)}`
    );
    check('fold-fuse welds > 30', stats.welds > 30, `welds=${stats.welds}`);
    check('fold-fuse sampled welds length <= 1.5x rest', sample === 0 || maxRatio <= 1.5, `maxRatio=${maxRatio.toFixed(3)}`);
    sc.report();
  }

  // A7.2 fold-squishy: temporary stickiness releases; the body recovers.
  {
    reset(SQUISHY);
    settle('fold-squishy');
    const reference = capture();
    const sc = new Scenario('fold-squishy', body, { checkRoughness: false });
    foldGesture(body, sc);
    sc.advance(3.0);
    const stats = body.stats();
    console.log(`fold-squishy: welds=${stats.welds} shapeError=${body.shapeError(reference).toFixed(4)}`);
    check('fold-squishy welds < 10 after release', stats.welds < 10, `welds=${stats.welds}`);
    check('fold-squishy shapeError <= 0.12', body.shapeError(reference) <= 0.12, `shapeError=${body.shapeError(reference).toFixed(4)}`);
    sc.report();
  }

  // A7.3 no pass-through (bouncy): the fold never sinks through the body.
  {
    reset(BOUNCY);
    settle('no-pass-through');
    const sc = new Scenario('no-pass-through', body, { checkRoughness: false });
    foldGesture(body, sc);
    sc.advance(1.0);
    const deep = deepPairCount(body);
    console.log(`no-pass-through: deepPairs=${deep} welds=${body.weldCount}`);
    check('no-pass-through deepPairs === 0', deep === 0, `deepPairs=${deep}`);
    sc.report();
  }

  // A7.1 two hands: opposite-side stretch.
  {
    reset(SQUISHY);
    settle('two-hands');
    const settledWidth = width(body);
    const left = midHeightExtreme(body, false);
    const right = midHeightExtreme(body, true);
    const lp = vertexPoint(body, left);
    const rp = vertexPoint(body, right);
    const hl = body.beginGrab(lp, CONFIG.grab.pull.radius);
    const hr = body.beginGrab(rp, CONFIG.grab.pull.radius);
    const sc = new Scenario('two-hands', body, { checkRoughness: false });
    sc.advance(0.5, (t) => {
      body.setGrabTarget(hl, lp.x - 1.0 * t, lp.y, lp.z);
      body.setGrabTarget(hr, rp.x + 1.0 * t, rp.y, rp.z);
    });
    sc.advance(0.4);
    console.log(
      `two-hands: width=${width(body).toFixed(3)} settled=${settledWidth.toFixed(3)} ` +
        `ratio=${(width(body) / settledWidth).toFixed(3)}`
    );
    check('two-hands width >= 1.6x settled', width(body) >= 1.6 * settledWidth, `ratio=${(width(body) / settledWidth).toFixed(3)}`);
    sc.report();
    body.endGrab(hl);
    body.endGrab(hr);
  }

  // A8.1 paint-visible: a dropped dollop stays a distinct patch at rest.
  {
    reset(SLIME);
    settle('paint-visible');
    body.setBaseColor([1.0, 0.4, 0.6]);
    const gi = topVertex(body);
    const gp = vertexPoint(body, gi);
    const nrm = vertexNormal(body, gi);
    body.paintColor(gp, 0.55, [0.2, 0.4, 1.0]);
    body.pokeAt(gp, nrm, 1.6);
    body.updateDerived(FRAME);
    const painted = colorVariance(body);
    const sc = new Scenario('paint-visible', body, { checkRoughness: false });
    sc.advance(1.0);
    const visible = colorVariance(body);
    const range = colorRange(body);
    console.log(`paint-visible: painted=${painted.toFixed(5)} after1s=${visible.toFixed(5)} ratio=${(visible / painted).toFixed(3)}`);
    check('paint-visible variance >= 80% painted', visible >= 0.8 * painted, `ratio=${(visible / painted).toFixed(3)}`);
    check('paint-visible stays in [0, 1]', range.lo >= -1e-6 && range.hi <= 1 + 1e-6, `range=[${range.lo}, ${range.hi}]`);
    sc.report();

    // A8.2 paint-knead-short: still visible after 3 s of kneading.
    const rng = makeRng(777);
    for (let c = 0; c < 6; c++) kneadCycle(body, sc, rng, 0.8, c % 2 === 0 ? 0.4 : -0.4);
    const short = colorVariance(body);
    console.log(`paint-knead-short: after=${short.toFixed(5)} ratio=${(short / painted).toFixed(3)}`);
    check('paint-knead-short variance >= 45% painted', short >= 0.45 * painted, `ratio=${(short / painted).toFixed(3)}`);

    // A8.3 paint-knead-long: 30 s of kneading incl. 4 fold gestures blends it.
    const sc2 = new Scenario('paint-knead-long', body, { checkRoughness: false });
    const rng2 = makeRng(777);
    let elapsed = 0;
    let folds = 0;
    let dir = 1;
    while (elapsed < 30) {
      if (folds < 4 && elapsed >= folds * 7.0) {
        foldGesture(body, sc2);
        elapsed += 1.6;
        folds += 1;
      } else {
        kneadCycle(body, sc2, rng2, 0.8, dir * 0.4);
        dir = -dir;
        elapsed += 0.5;
      }
    }
    const long = colorVariance(body);
    console.log(`paint-knead-long: after=${long.toFixed(5)} ratio=${(long / painted).toFixed(3)} folds=${folds}`);
    check('paint-knead-long variance <= 60% painted', long <= 0.6 * painted, `ratio=${(long / painted).toFixed(3)}`);
    check('paint-knead-long finite positions', finitePositions(body), 'non-finite position after long knead');
  }

  // A8.4 idle-no-recolor: nothing is re-skinned while the body rests.
  {
    reset(SQUISHY);
    settle('idle-no-recolor');
    const v0 = body.colorVersion;
    const sc = new Scenario('idle-no-recolor', body, { checkRoughness: false });
    sc.advance(3.0);
    console.log(`idle-no-recolor: colorVersion ${v0} -> ${body.colorVersion}`);
    check('idle-no-recolor colorVersion unchanged', body.colorVersion === v0, `version ${v0} -> ${body.colorVersion}`);
  }

  // A8.5 slime-knead: plastic slime does not puddle without bound.
  {
    reset(SLIME);
    settle('slime-knead');
    const sc = new Scenario('slime-knead', body, { checkRoughness: false });
    const rng = makeRng(1234);
    for (let c = 0; c < 6; c++) kneadCycle(body, sc, rng, 0.8, c % 2 === 0 ? 1.0 : -1.0);
    sc.advance(1.0);
    console.log(
      `slime-knead: width=${width(body).toFixed(3)} maxY=${body.bounds.maxY.toFixed(3)} flippedFrames=${sc.flips}`
    );
    check('slime-knead width <= 3.4', width(body) <= 3.4, `width=${width(body).toFixed(3)}`);
    check('slime-knead maxY >= 0.85', body.bounds.maxY >= 0.85, `maxY=${body.bounds.maxY.toFixed(3)}`);
    check('slime-knead flipped === 0', sc.flips === 0, `first bad ${JSON.stringify(sc.firstBad)}`);
    sc.report();
  }

  // A10 five-hands: five simultaneous hands stretch in five directions.
  {
    reset(SQUISHY);
    settle('five-hands');
    const cx = body.centroid.x;
    const cz = body.centroid.z;
    const top = topVertex(body);
    const left = midHeightExtreme(body, false);
    const right = midHeightExtreme(body, true);
    let front = -1;
    let back = -1;
    let frontZ = -Infinity;
    let backZ = Infinity;
    for (let i = 0; i < body.count; i++) {
      const y = body.pos[i * 3 + 1];
      if (y < 0.6 || y > 1.0) continue;
      const z = body.pos[i * 3 + 2];
      if (z > frontZ) { frontZ = z; front = i; }
      if (z < backZ) { backZ = z; back = i; }
    }
    const picks = [top, left, right, front, back];
    const targets = picks.map((vi) => vertexPoint(body, vi));
    const handles = picks.map((vi, k) => body.beginGrab(targets[k], CONFIG.grab.pull.radius));
    const sc = new Scenario('five-hands', body, { checkRoughness: false });
    sc.advance(0.5, (t) => {
      for (let k = 0; k < handles.length; k++) {
        const p = targets[k];
        if (k === 0) {
          body.setGrabTarget(handles[k], p.x, p.y + 1.0 * t, p.z);
        } else {
          const dx = p.x - cx;
          const dz = p.z - cz;
          const len = Math.hypot(dx, dz) || 1;
          body.setGrabTarget(handles[k], p.x + (dx / len) * 1.0 * t, p.y, p.z + (dz / len) * 1.0 * t);
        }
      }
    });
    sc.advance(1.0);
    const stats = body.stats();
    let maxDist = 0;
    for (let k = 0; k < handles.length; k++) {
      const d = nearestSurfaceDist(body, body.hands[handles[k]].target);
      if (d > maxDist) maxDist = d;
    }
    console.log(`five-hands: maxNearestDist=${maxDist.toFixed(3)} volumeRatio=${stats.volumeRatio.toFixed(4)}`);
    check('five-hands nearest vertex within 0.25', maxDist <= 0.25, `maxDist=${maxDist.toFixed(3)}`);
    check('five-hands volumeRatio >= 0.9', stats.volumeRatio >= 0.9, `volumeRatio=${stats.volumeRatio.toFixed(4)}`);
    sc.report();
    for (const h of handles) body.endGrab(h);
    const rel = new Scenario('five-hands-release', body, { checkRoughness: false });
    rel.advance(3.0);
    rel.report();
  }

  // A10 ten-hands: ten hands spread over the upper hemisphere stretch outward.
  {
    reset(SQUISHY);
    settle('ten-hands');
    const cx = body.centroid.x;
    const cy = body.centroid.y;
    const cz = body.centroid.z;
    const picks = upperHemisphereHands(body, 10);
    const targets = picks.map((vi) => vertexPoint(body, vi));
    const handles = picks.map((vi, k) => body.beginGrab(targets[k], CONFIG.grab.pull.radius));
    const sc = new Scenario('ten-hands', body, { checkRoughness: false });
    sc.advance(0.5, (t) => {
      for (let k = 0; k < handles.length; k++) {
        const p = targets[k];
        const dx = p.x - cx;
        const dy = p.y - cy;
        const dz = p.z - cz;
        const len = Math.hypot(dx, dy, dz) || 1;
        body.setGrabTarget(handles[k], p.x + (dx / len) * 0.6 * t, p.y + (dy / len) * 0.6 * t, p.z + (dz / len) * 0.6 * t);
      }
    });
    sc.advance(1.0);
    sc.report();
    for (const h of handles) body.endGrab(h);
    const rel = new Scenario('ten-hands-release', body, { checkRoughness: false });
    rel.advance(3.0);
    rel.report();
  }

  // A11 five-fingers-browser: the app's real five-finger gesture (dent, hold-sink
  // with a growing radius, then a screen-plane outward pull) must not flip a tet.
  {
    reset(SQUISHY);
    settle('five-fingers-browser');
    const picks = frontUpperHands(body, 5);
    const cx = body.centroid.x;
    const cz = body.centroid.z;
    const normals = picks.map((vi) => surfaceNormalAt(body, vi));
    const base = picks.map((vi) => vertexPoint(body, vi));
    const handles = picks.map((vi, k) => body.beginGrab(base[k], CONFIG.grab.pull.radius));
    const sc = new Scenario('five-fingers-browser', body, { checkRoughness: false });
    let minVol = Infinity;

    // dent of 0.12 along -normal over 0.15 s
    sc.advance(0.15, (t) => {
      for (let k = 0; k < handles.length; k++) {
        const p = base[k];
        const n = normals[k];
        const d = 0.12 * t;
        body.setGrabTarget(handles[k], p.x - n.x * d, p.y - n.y * d, p.z - n.z * d);
      }
    });

    // hold-sink to 0.3 over 0.4 s, grab radius growing 0.42 -> 0.62, re-selected
    // every 0.1 s
    let radiusStep = 0;
    sc.advance(0.4, (t) => {
      for (let k = 0; k < handles.length; k++) {
        const p = base[k];
        const n = normals[k];
        const d = 0.12 + 0.18 * t;
        body.setGrabTarget(handles[k], p.x - n.x * d, p.y - n.y * d, p.z - n.z * d);
      }
      const want = Math.min(4, Math.floor(t * 4 + 1e-6));
      while (radiusStep < want) {
        radiusStep += 1;
        const rt = radiusStep / 4;
        const r = CONFIG.grab.pull.radius + (CONFIG.grab.pull.holdMaxRadius - CONFIG.grab.pull.radius) * rt;
        for (let k = 0; k < handles.length; k++) body.setGrabRadius(handles[k], r);
      }
    });

    // outward pull in the screen-plane direction by 1.2 plus +0.2 y over 0.5 s,
    // the sink held at its 0.3 maximum throughout
    const outward = (t) => {
      for (let k = 0; k < handles.length; k++) {
        const p = base[k];
        const n = normals[k];
        let dx = p.x - cx;
        let dy = p.y - body.centroid.y;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len;
        dy /= len;
        const ox = dx * 1.2 * t;
        const oy = dy * 1.2 * t + 0.2 * t;
        body.setGrabTarget(handles[k], p.x + ox - n.x * 0.3, p.y + oy - n.y * 0.3, p.z - n.z * 0.3);
      }
    };
    const advanceHeld = (seconds, onFrame) => {
      const frames = Math.round(seconds / FRAME);
      for (let f = 0; f < frames; f++) {
        if (onFrame) onFrame((f + 1) / frames);
        for (let s = 0; s < SUBSTEPS; s++) body.step(H);
        body.updateDerived(FRAME);
        sc.sample((f + 1) / frames);
        const vr = body.stats().volumeRatio;
        if (vr < minVol) minVol = vr;
      }
    };
    advanceHeld(0.5, outward);
    advanceHeld(1.0);

    console.log(
      `five-fingers-browser: minVolumeRatio=${minVol.toFixed(4)} flippedFrames=${sc.flips} ` +
        `nonFiniteFrames=${sc.nonFinite} firstBad=${JSON.stringify(sc.firstBad)}`
    );
    check('five-fingers-browser flipped === 0', sc.flips === 0, `first bad ${JSON.stringify(sc.firstBad)}`);
    check('five-fingers-browser finite positions', sc.nonFinite === 0, `first bad ${JSON.stringify(sc.firstBad)}`);
    check('five-fingers-browser volumeRatio >= 0.88 while held', minVol >= 0.88, `minVolumeRatio=${minVol.toFixed(4)}`);

    for (const h of handles) body.endGrab(h);
    const rel = new Scenario('five-fingers-browser-release', body, { checkRoughness: false });
    rel.advance(3.0);
    rel.report();
  }

  // A10 release curves: the four presets each recover in their own way.
  {
    const relSq = releaseCurve(body, SQUISHY, 'release-curve-squishy');
    checkCurve('release-curve-squishy', relSq, { t50Min: 0.12, t50Max: 0.35, underMax: 0.06, settleMax: 1.5 });

    const relSlow = releaseCurve(body, SLOW, 'release-curve-slow');
    checkCurve('release-curve-slow', relSlow, { t50Min: 0.8, t50Max: 2.0, underMax: 0.01, settleMax: 5 });

    const relBouncy = releaseCurve(body, BOUNCY, 'release-curve-bouncy');
    checkCurve('release-curve-bouncy', relBouncy, { t50Min: 0, t50Max: 0.12, underMin: 0.05, underMax: 0.3, settleMax: 5 });

    // slime: keeps the pull (plastic memory).
    body.setParams(resolvePhysics(SLIME));
    body.reset({ drop: false });
    const settleSc = new Scenario('release-curve-slime-settle', body);
    settleSc.advance(CURVE_SETTLE);
    settleSc.report();
    const settled = body.bounds.maxY;
    const gi = topVertex(body);
    const gp = vertexPoint(body, gi);
    const handle = body.beginGrab(gp, CONFIG.grab.pull.radius);
    const sc = new Scenario('release-curve-slime', body, { checkRoughness: false });
    sc.advance(0.4, (t) => body.setGrabTarget(handle, gp.x, gp.y + 1.0 * t, gp.z));
    sc.advance(0.5);
    const D0 = body.bounds.maxY - settled;
    body.endGrab(handle);
    sc.advance(2.0);
    const kept = body.bounds.maxY - settled;
    console.log(`  release-curve-slime: settled=${settled.toFixed(3)} D0=${D0.toFixed(3)} kept=${kept.toFixed(3)}`);
    check('release-curve-slime keeps maxY >= settled + 0.3 D0', kept >= 0.3 * D0, `kept=${kept.toFixed(3)} D0=${D0.toFixed(3)}`);
    sc.report();
  }

  // A10 press curves: 말랑이 and 슬로우 recover from a deep palm press.
  {
    const pSq = pressCurve(body, SQUISHY, 'press-curve-squishy');
    checkCurve('press-curve-squishy', pSq, { t50Min: 0.12, t50Max: 0.35, underMax: 0.06, settleMax: 1.5 });

    const pSlow = pressCurve(body, SLOW, 'press-curve-slow');
    checkCurve('press-curve-slow', pSlow, { t50Min: 0.8, t50Max: 2.0, underMax: 0.01, settleMax: 5 });
  }

  // A10 stretch attribute: ~1 at rest, >= 1.4 under a pull.
  {
    reset(SQUISHY);
    settle('stretch-attr');
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < body.count; i++) {
      const s = body.surfaceStretch[i];
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    console.log(`  stretch-attr: at rest [${lo.toFixed(3)}, ${hi.toFixed(3)}] version=${body.stretchVersion}`);
    check('stretch-attr at rest all in [0.9, 1.1]', lo >= 0.9 && hi <= 1.1, `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
    const gi = topVertex(body);
    const gp = vertexPoint(body, gi);
    const handle = body.beginGrab(gp, CONFIG.grab.pull.radius);
    const sc = new Scenario('stretch-attr', body, { checkRoughness: false });
    let maxS = 0;
    sc.advance(0.5, (t) => {
      body.setGrabTarget(handle, gp.x, gp.y + 1.0 * t, gp.z);
      for (let i = 0; i < body.count; i++) if (body.surfaceStretch[i] > maxS) maxS = body.surfaceStretch[i];
    });
    sc.advance(1.0);
    for (let i = 0; i < body.count; i++) if (body.surfaceStretch[i] > maxS) maxS = body.surfaceStretch[i];
    console.log(`  stretch-attr: during pull-small hold maxStretch=${maxS.toFixed(3)}`);
    check('stretch-attr during pull-small hold max >= 1.4', maxS >= 1.4, `maxStretch=${maxS.toFixed(3)}`);
    body.endGrab(handle);
    sc.report();
  }

  // A12 press-crush: a deep palm press at the crush floor must not collapse the
  // body or leave a tet inverted (both configs, all four presets).
  {
    pressCrush(body, SQUISHY, 'press-crush-squishy');
    pressCrush(body, SLOW, 'press-crush-slow');
    pressCrush(body, SLIME, 'press-crush-slime');
    pressCrush(body, BOUNCY, 'press-crush-bouncy');
  }

  // A12 stress-random: a seeded browser-like stress must never collapse the body.
  {
    stressRandom(body, 'stress-random');
  }

  // A10 perf: 5 hands active, desktop config targets.
  {
    reset(SQUISHY);
    const picks = upperHemisphereHands(body, 5);
    const handles = picks.map((vi) => body.beginGrab(vertexPoint(body, vi), CONFIG.grab.pull.radius));
    const steps = 600;
    let stepMs = 0;
    let derivedMs = 0;
    for (let s = 0; s < steps; s++) {
      let t0 = performance.now();
      body.step(H);
      stepMs += performance.now() - t0;
      t0 = performance.now();
      body.updateDerived(FRAME);
      derivedMs += performance.now() - t0;
    }
    const perStep = stepMs / steps;
    const perDerived = derivedMs / steps;
    console.log(
      `perf-5-hands: ${perStep.toFixed(3)} ms/step, ${perDerived.toFixed(3)} ms/updateDerived ` +
        `(${steps} steps, nodes=${body.nodeCount}, tets=${body.tetCount})`
    );
    if (n === 24) {
      check('perf step <= 0.8 ms/step at n=24 (5 hands)', perStep <= 0.8, `${perStep.toFixed(3)} ms/step`);
      check('perf updateDerived <= 0.7 ms at n=24', perDerived <= 0.7, `${perDerived.toFixed(3)} ms`);
    }
    for (const h of handles) body.endGrab(h);
  }
}

for (const [n, spacing] of [[24, 0.17], [16, 0.24]]) {
  runConfig(n, spacing);
}

// 13. setParams strict validation: a non-finite required key must throw.
{
  const mesh = buildGeodesic(16);
  const body = new SoftBody({ rest: mesh.rest, index: mesh.index, floorY: 0, spacing: 0.2 });
  const base = resolvePhysics({ ...CONFIG.defaults.physics });
  const requireThrow = (label, mutate) => {
    const params = { ...base };
    mutate(params);
    let threw = false;
    let message = '';
    try {
      body.setParams(params);
    } catch (error) {
      threw = true;
      message = error.message;
    }
    check(`setParams rejects ${label}`, threw, `no throw (message=${message})`);
    console.log(`  setParams threw: ${threw ? message : '(nothing)'}`);
  };
  requireThrow('non-finite freeFriction', (p) => { p.freeFriction = undefined; });
  requireThrow('missing fuse', (p) => { delete p.fuse; });
}

if (failures > 0) {
  console.log(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log('\nall scenarios passed.');
