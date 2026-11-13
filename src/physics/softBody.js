import { CONFIG } from '../config.js';
import { buildTopology } from './topology.js';
import { tetrahedralize } from './tetrahedralize.js';

/**
 * Volumetric XPBD soft body with an embedded render surface.
 *
 * Pure JavaScript on purpose — no three.js import — so the whole solver runs in
 * Node for tests. The renderer reads `body.pos` directly; the same Float32Array
 * instance lives for the entire body lifetime.
 *
 * A real squishy is a solid, so the simulation volume is a tetrahedral mesh
 * driven by XPBD edge and tet-volume constraints. The smooth render surface is
 * skinned from the tet nodes with precomputed barycentric coordinates. This
 * gives interior material that resists tangential buckling, so the surface stays
 * smooth instead of folding like a hollow cloth.
 *
 * The public body API (pos, count, rest, restNormals, topo, bounds, nodeBounds,
 * spacing, boundaryCount, contact, centroid, hands, grabbed, activeHandCount,
 * press, floorY, normalsDirty, energy, maxDisp, nodeColor, surfaceColor,
 * colorVersion, surfaceStretch, stretchVersion, setParams, step, updateDerived,
 * beginGrab, setGrabPush, setGrabTarget, setGrabRadius, endGrab, signals,
 * topHeightAt, beginPress, setPress, endPress, pokeAt, setBaseColor, paintColor,
 * drop, reset, stats) is consumed by the render/input/UI layers.
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Floor contact model (round 4). The base sticks to the table until the pull
 * is strong enough to peel it off, and the contact patch may spread outward
 * while the palm presses. Any residual rigid in-plane drift of the contact
 * patch is removed each substep, so a side pull stretches the body against a
 * held base instead of dragging the whole blob across the floor.
 */
const PEEL_LIFT = 1.5;

/**
 * Adaptive refinement. One solver sweep per substep cannot always carry a load
 * (several pushing fingers, a finger dragging the body across the table) through
 * the body, and a tet is left inverted after the inversion recovery. Only then
 * up to REFINE_MAX more edge + volume + recovery iterations run in the same
 * substep (also while two or more fingers carry more than REFINE_LOAD body
 * weights together and a tet was inverted before the recovery), so a healthy
 * body never pays for them and the calibrated force-to-depth response of a
 * normal single push is untouched.
 */
const REFINE_LOAD = 1.5;
const RECOVER_SCAN_RATIO = 0.4;
const REFINE_MAX = 3;
const SPREAD_FRICTION = 0.94;
const FLOOR_CONTACT_EPS = 0.03;

/**
 * Every key the solver reads from `this.params`. setParams rejects a parameter
 * object unless all of these are present and finite; the solver never supplies
 * a default for a missing key.
 */
const REQUIRED_PARAMS = Object.freeze([
  'gravity',
  'edgeCompliance',
  'volumeCompliance',
  'plasticRate',
  'plasticYield',
  'shapeRate',
  'linearDamping',
  'viscosity',
  'grabStiffness',
  'floorFriction',
  'staticFriction',
  'freeFriction',
  'tackBreak',
  'fuse',
  'weldBreak',
  'edgeMix',
  'weldMix',
  'weldLife',
  'viscoRelease',
  'creepTime',
  'pushGain',
  'skinSmoothIterations',
]);

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Blend the colours of nodes i and j toward their mean by `mix`. */
function mixPair(nodeColor, i, j, mix) {
  const i3 = i * 3;
  const j3 = j * 3;
  for (let c = 0; c < 3; c++) {
    const mean = (nodeColor[i3 + c] + nodeColor[j3 + c]) * 0.5;
    nodeColor[i3 + c] += (mean - nodeColor[i3 + c]) * mix;
    nodeColor[j3 + c] += (mean - nodeColor[j3 + c]) * mix;
  }
}

/** Row-major 3x3 rotation matrix from a quaternion [x, y, z, w]. */
function quatToMat3(x, y, z, w, out) {
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  out[0] = 1 - (yy + zz);
  out[1] = xy - wz;
  out[2] = xz + wy;
  out[3] = xy + wz;
  out[4] = 1 - (xx + zz);
  out[5] = yz - wx;
  out[6] = xz - wy;
  out[7] = yz + wx;
  out[8] = 1 - (xx + yy);
  return out;
}

/**
 * Rotation factor of a 3x3 matrix via Müller's iterative extraction (2016).
 * `A` is row-major 9; `q` is [x, y, z, w] and is updated in place so the next
 * call warm-starts. Returns the row-major rotation `R` that best maps `A`.
 */
function extractRotation(A, q, iterations) {
  const R = new Float64Array(9);
  for (let it = 0; it < iterations; it++) {
    quatToMat3(q[0], q[1], q[2], q[3], R);
    let nx = 0;
    let ny = 0;
    let nz = 0;
    let den = 0;
    for (let c = 0; c < 3; c++) {
      const r0 = R[c];
      const r1 = R[3 + c];
      const r2 = R[6 + c];
      const a0 = A[c];
      const a1 = A[3 + c];
      const a2 = A[6 + c];
      nx += r1 * a2 - r2 * a1;
      ny += r2 * a0 - r0 * a2;
      nz += r0 * a1 - r1 * a0;
      den += r0 * a0 + r1 * a1 + r2 * a2;
    }
    den = Math.abs(den) + 1e-9;
    const ox = nx / den;
    const oy = ny / den;
    const oz = nz / den;
    const w = Math.hypot(ox, oy, oz);
    if (w < 1e-9) break;
    const s = Math.sin(w * 0.5) / w;
    const dqx = ox * s;
    const dqy = oy * s;
    const dqz = oz * s;
    const dqw = Math.cos(w * 0.5);
    const qx = q[0];
    const qy = q[1];
    const qz = q[2];
    const qw = q[3];
    const rx = dqw * qx + dqx * qw + dqy * qz - dqz * qy;
    const ry = dqw * qy - dqx * qz + dqy * qw + dqz * qx;
    const rz = dqw * qz + dqx * qy - dqy * qx + dqz * qw;
    const rw = dqw * qw - dqx * qx - dqy * qy - dqz * qz;
    const inv = 1 / Math.hypot(rx, ry, rz, rw);
    q[0] = rx * inv;
    q[1] = ry * inv;
    q[2] = rz * inv;
    q[3] = rw * inv;
  }
  return quatToMat3(q[0], q[1], q[2], q[3], R);
}

/** Area-weighted vertex normals of the rest surface, in pure JS. */
function computeRestNormals(out, pos, tris) {
  out.fill(0);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3;
    const b = tris[t + 1] * 3;
    const c = tris[t + 2] * 3;
    const abx = pos[b] - pos[a];
    const aby = pos[b + 1] - pos[a + 1];
    const abz = pos[b + 2] - pos[a + 2];
    const acx = pos[c] - pos[a];
    const acy = pos[c + 1] - pos[a + 1];
    const acz = pos[c + 2] - pos[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    out[a] += nx;
    out[a + 1] += ny;
    out[a + 2] += nz;
    out[b] += nx;
    out[b + 1] += ny;
    out[b + 2] += nz;
    out[c] += nx;
    out[c + 1] += ny;
    out[c + 2] += nz;
  }
  for (let i = 0; i < out.length; i += 3) {
    const inv = 1 / Math.max(Math.hypot(out[i], out[i + 1], out[i + 2]), 1e-12);
    out[i] *= inv;
    out[i + 1] *= inv;
    out[i + 2] *= inv;
  }
}

export class SoftBody {
  constructor({ rest, index, floorY, spacing }) {
    if (!rest || rest.length === 0 || rest.length % 3 !== 0) {
      throw new Error('SoftBody requires a non-empty rest position array.');
    }
    if (!index || index.length === 0) {
      throw new Error('SoftBody requires a triangle index array.');
    }
    if (!Number.isFinite(spacing) || spacing <= 0) {
      throw new Error(`SoftBody requires a positive spacing; got ${spacing}`);
    }

    this.count = rest.length / 3;
    this.floorY = floorY;

    this.rest = new Float32Array(rest);
    this.pos = new Float32Array(rest);
    this.restNormals = new Float32Array(rest.length);

    this.topo = buildTopology(index, this.count);
    computeRestNormals(this.restNormals, this.rest, this.topo.tris);

    // CSR vertex adjacency of the surface, used by the roughness metric.
    const surfaceEdges = this.topo.edges;
    this.nbrStart = new Int32Array(this.count + 1);
    for (let e = 0; e < surfaceEdges.length; e += 2) {
      this.nbrStart[surfaceEdges[e] + 1] += 1;
      this.nbrStart[surfaceEdges[e + 1] + 1] += 1;
    }
    for (let i = 0; i < this.count; i++) this.nbrStart[i + 1] += this.nbrStart[i];
    this.nbrs = new Int32Array(surfaceEdges.length);
    const nbrCursor = this.nbrStart.slice(0, this.count);
    for (let e = 0; e < surfaceEdges.length; e += 2) {
      const a = surfaceEdges[e];
      const b = surfaceEdges[e + 1];
      this.nbrs[nbrCursor[a]++] = b;
      this.nbrs[nbrCursor[b]++] = a;
    }

    let restEdgeSum = 0;
    for (let e = 0; e < surfaceEdges.length; e += 2) {
      const i = surfaceEdges[e] * 3;
      const j = surfaceEdges[e + 1] * 3;
      restEdgeSum += Math.hypot(this.rest[j] - this.rest[i], this.rest[j + 1] - this.rest[i + 1], this.rest[j + 2] - this.rest[i + 2]);
    }
    this.meanRestEdge = restEdgeSum / this.topo.edgeCount;

    // --- Tetrahedral volume -------------------------------------------------
    const tet = tetrahedralize({ surfacePos: this.rest, index, spacing });
    this.tet = tet;
    this.nodeCount = tet.nodeCount;
    this.tetCount = tet.tetCount;
    this.nodeRest = tet.nodes;
    this.nodePos = new Float32Array(tet.nodes);
    this.nodePrev = new Float32Array(tet.nodes.length);
    this.nodeVel = new Float32Array(tet.nodes.length);

    // Rest frame of the shape-matching goal: node rest positions minus their
    // centroid. Plasticity never touches it, so the goal shape stays the
    // original solid while the plastic rest lengths drift.
    let restCx = 0;
    let restCy = 0;
    let restCz = 0;
    for (let i = 0; i < this.nodeCount; i++) {
      restCx += this.nodeRest[i * 3];
      restCy += this.nodeRest[i * 3 + 1];
      restCz += this.nodeRest[i * 3 + 2];
    }
    restCx /= this.nodeCount;
    restCy /= this.nodeCount;
    restCz /= this.nodeCount;
    this.nodeRestLocal = new Float32Array(this.nodeRest.length);
    for (let i = 0; i < this.nodeCount; i++) {
      this.nodeRestLocal[i * 3] = this.nodeRest[i * 3] - restCx;
      this.nodeRestLocal[i * 3 + 1] = this.nodeRest[i * 3 + 1] - restCy;
      this.nodeRestLocal[i * 3 + 2] = this.nodeRest[i * 3 + 2] - restCz;
    }
    // The shape-matching goal is the SETTLED node frame (the rest shape squashed
    // onto the floor by gravity), captured once the body first comes to rest
    // after a reset. Matching the settled shape instead of the undeformed rest
    // means the memory does not fight gravity, so the body is not prestressed
    // upward and a pull still stretches it.
    this.shapeGoalLocal = new Float32Array(this.nodeRestLocal);
    this.shapeGoalReady = false;
    this.idleTime = 0;
    this.shapeMatchQuat = [0, 0, 0, 1];
    this.creepQuat = [0, 0, 0, 1];
    this.creepA = new Float64Array(9);
    // Recovery ramp (v4): the shape-matching memory is off while a gesture is
    // active and fades back in linearly over CONFIG.feel.shapeRampSeconds once
    // the last hand/press is released, so a released squishy rises smoothly
    // instead of snapping.
    this.shapeRamp = 0;
    this.shapeA = new Float64Array(9);
    this.invMass = tet.invMass;
    this.edges = tet.edges;
    this.tets = tet.tets;
    this.tetRest0 = tet.restVol;
    this.embedTet = tet.embedTet;
    this.embedBary = tet.embedBary;

    // Total mass = Σ 1/invMass over the movable nodes; because each tet's rest
    // volume is split evenly over its four vertices this equals the total rest
    // volume. Body weight W = totalMass · gravity drives the finger force (v7).
    this.totalMass = 0;
    for (let i = 0; i < this.nodeCount; i++) {
      if (this.invMass[i] > 0) this.totalMass += 1 / this.invMass[i];
    }

    // Global volume constraint scratch (round 11): the accumulated per-node
    // gradient of the total tet volume, plus the target total rest volume.
    this.volumeGrad = new Float32Array(this.nodeCount * 3);
    this.totalRestVolume = 0;
    for (let t = 0; t < this.tetCount; t++) this.totalRestVolume += this.tetRest0[t];
    // Per-node flag: the node is a vertex of at least one inverted tet. Plastic
    // flow skips the edges of inverted tets so a collapsed tet is never baked
    // into the rest shape.
    this.nodeInverted = new Uint8Array(this.nodeCount);
    this.invertedCount = 0;
    this.minTetRatio = 1;

    // Displacement-field smoothing of the skinned surface (round 5): the render
    // surface is skinned from a coarse tet grid, so the displacement field is
    // umbrella-smoothed to hide the piecewise-linear tet faces.
    this.disp = new Float32Array(rest.length);
    this.dispTmp = new Float32Array(rest.length);
    this.shapeQuat = [0, 0, 0, 1];

    this.edgeRest0 = new Float32Array(tet.edgeCount);
    this.edgeRest = new Float32Array(tet.edgeCount);
    for (let k = 0; k < tet.edgeCount; k++) {
      const i = this.edges[2 * k] * 3;
      const j = this.edges[2 * k + 1] * 3;
      const length = Math.hypot(
        this.nodeRest[j] - this.nodeRest[i],
        this.nodeRest[j + 1] - this.nodeRest[i + 1],
        this.nodeRest[j + 2] - this.nodeRest[i + 2]
      );
      this.edgeRest0[k] = length;
      this.edgeRest[k] = length;
    }

    this.spacing = spacing;
    // Effective palm-press floor (round 11): the palm may not press the body
    // thinner than max(CONFIG.grab.press.minThickness, pressMinLayers · spacing),
    // so a deep press can never crush a single layer of tets through itself. The
    // pointer layer reads this to clamp its press depth.
    this.pressMinThickness = Math.max(
      CONFIG.grab.press.minThickness,
      CONFIG.grab.press.pressMinLayers * spacing
    );

    // --- Multi-hand grab ------------------------------------------------------
    // Up to CONFIG.grab.maxHands simultaneous hands. Each hand owns its selected
    // node list, gaussian weights and offsets (current position − target).
    this.hands = [];
    for (let h = 0; h < CONFIG.grab.maxHands; h++) {
      this.hands.push({
        active: false,
        target: { x: 0, y: 0, z: 0 },
        origin: { x: 0, y: 0, z: 0 },
        // v7 finger force: `normal` is the unit outward surface normal at the
        // touch, `push` the current force in body weights, `depth` the low-passed
        // sink depth (positive = pushed in) and `center` the patch centroid.
        normal: { x: 0, y: 1, z: 0 },
        push: 0,
        depth: 0,
        center: { x: 0, y: 0, z: 0 },
        radius: 0,
        count: 0,
        idx: new Int32Array(this.nodeCount),
        w: new Float32Array(this.nodeCount),
        off: new Float32Array(this.nodeCount * 3),
      });
    }
    this.contactIdx = new Int32Array(this.nodeCount);

    // Scratch for the weighted-average grab solve: when several hand patches
    // overlap, a shared node is pulled toward the weighted mean of the hands'
    // targets instead of being yanked by each hand in turn (which tears the
    // tets apart when the targets disagree).
    this.grabAccum = new Float32Array(this.nodeCount * 3);
    this.grabWeight = new Float32Array(this.nodeCount);
    this.grabTouched = new Int32Array(this.nodeCount);
    // Per-node normal component of the pin correction that is released while a
    // finger pushes (v7), subtracted in the averaged multi-hand solve.
    this.grabRelease = new Float32Array(this.nodeCount * 3);

    // --- Self-collision + fusion ---------------------------------------------
    // Boundary nodes (fewer incident tets than a fully interior grid node) are
    // the only ones that may collide. A pair collides when it is close in space
    // but far apart in the material (a fold); a fused pair becomes a weld — a
    // distance constraint solved with the edge compliance.
    const degree = new Int32Array(this.nodeCount);
    for (let t = 0; t < this.tetCount; t++) {
      const b = t * 4;
      degree[this.tets[b]] += 1;
      degree[this.tets[b + 1]] += 1;
      degree[this.tets[b + 2]] += 1;
      degree[this.tets[b + 3]] += 1;
    }
    let interiorDegree = 0;
    for (let i = 0; i < this.nodeCount; i++) {
      if (degree[i] > interiorDegree) interiorDegree = degree[i];
    }
    this.boundary = new Uint8Array(this.nodeCount);
    this.boundaryCount = 0;
    for (let i = 0; i < this.nodeCount; i++) {
      if (degree[i] < interiorDegree) {
        this.boundary[i] = 1;
        this.boundaryCount += 1;
      }
    }
    this.boundaryNodes = new Int32Array(this.boundaryCount);
    let bc = 0;
    for (let i = 0; i < this.nodeCount; i++) {
      if (this.boundary[i]) this.boundaryNodes[bc++] = i;
    }

    this.collideDist = CONFIG.knead.collideFactor * spacing;
    this.restFar = CONFIG.knead.restFar * spacing;
    this.maxWelds = CONFIG.knead.maxWelds;
    this.collideRelax = 0.15;
    this.substepCount = 0;
    this.peeling = false;
    this.collisions = 0;

    let hashCap = 16;
    while (hashCap < this.boundaryCount * 2) hashCap <<= 1;
    this.hashCap = hashCap;
    this.hashHead = new Int32Array(hashCap);
    this.hashNext = new Int32Array(this.boundaryCount);
    this.cellX = new Int32Array(this.boundaryCount);
    this.cellY = new Int32Array(this.boundaryCount);
    this.cellZ = new Int32Array(this.boundaryCount);

    this.weldA = new Int32Array(this.maxWelds);
    this.weldB = new Int32Array(this.maxWelds);
    this.weldRest0 = new Float32Array(this.maxWelds);
    this.weldRest = new Float32Array(this.maxWelds);
    this.weldLprev = new Float32Array(this.maxWelds);
    this.weldAge = new Float32Array(this.maxWelds);
    this.weldCount = 0;
    this.weldSet = new Set();

    // --- Colour field ---------------------------------------------------------
    this.nodeColor = new Float32Array(this.nodeCount * 3).fill(1);
    this.surfaceColor = new Float32Array(rest.length).fill(1);
    this.colorsDirty = true;
    this.colorVersion = 0;
    this.edgeLprev = new Float32Array(this.edgeRest0.length);
    for (let k = 0; k < this.edgeLprev.length; k++) this.edgeLprev[k] = this.edgeRest0[k];

    // --- Stretch attribute ----------------------------------------------------
    // Per surface vertex, (current one-ring triangle area) / (rest one-ring
    // area), smoothed once over the surface neighbours. The renderer reads it as
    // a vertex attribute; the same Float32Array instance lives for the body.
    this.buildStretchTopology();

    this.press = { active: false, x: 0, z: 0, y: 0, radius: 0 };

    this.params = {
      gravity: CONFIG.simulation.gravity,
      edgeCompliance: 5e-3,
      volumeCompliance: 0,
      plasticRate: 0,
      plasticYield: 0.02,
      shapeRate: 0,
      linearDamping: 1.0,
      viscosity: 0.1,
      grabStiffness: 1.0,
      floorFriction: CONFIG.simulation.floorFriction,
      freeFriction: CONFIG.simulation.freeFriction,
      staticFriction: CONFIG.simulation.staticFriction,
      tackBreak: 1.0,
      fuse: 1,
      weldBreak: 1.35,
      edgeMix: 0.015,
      weldMix: 0.25,
      weldLife: 0.5,
      viscoRelease: 0,
      pushGain: 1,
      skinSmoothIterations: 2,
    };

    this.centroid = { x: 0, y: 0, z: 0 };
    this.bounds = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0, cx: 0, cy: 0, cz: 0, radius: 0 };
    this.nodeBounds = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
    this.contact = { x: 0, z: 0, radius: 0, count: 0, minY: 0 };
    this.energy = 0;
    this.maxDisp = 0;
    this.normalsDirty = true;

    // Feedback signals (v7), refreshed once per updateDerived: how much the body
    // is deforming, the last floor impact speed, welds broken and how fast the
    // fingers are sinking. Consumed by the audio layer and the finger proxy.
    this.signals = { deformRate: 0, impact: 0, weldBreaks: 0, depthRate: 0 };
    this.impactPending = 0;
    this.weldBreaksSinceUpdate = 0;
    this.depthRateSum = 0;
    this.stepsSinceUpdate = 0;
    this.prevFloorContactCount = 0;
    this.prevCentroidVelY = 0;

    this.updateDerived(0);
  }

  /** True while at least one hand is active. */
  get grabbed() {
    for (let h = 0; h < this.hands.length; h++) {
      if (this.hands[h].active) return true;
    }
    return false;
  }

  /** Total finger push of the active hands, in body weights. */
  fingerLoad() {
    let load = 0;
    for (let h = 0; h < this.hands.length; h++) {
      const hand = this.hands[h];
      if (hand.active) load += hand.push;
    }
    return load;
  }

  /** Number of active hands. */
  activeHandCount() {
    let n = 0;
    for (let h = 0; h < this.hands.length; h++) {
      if (this.hands[h].active) n += 1;
    }
    return n;
  }

  setParams(resolved) {
    const missing = [];
    for (const key of REQUIRED_PARAMS) {
      if (resolved == null || !Number.isFinite(resolved[key])) missing.push(key);
    }
    if (missing.length > 0) {
      throw new Error(`SoftBody params missing or non-finite: ${missing.join(', ')}`);
    }
    this.params = resolved;
  }

  /** One fixed substep. `h` is CONFIG.simulation.fixedDt. */
  step(h) {
    const { nodePos, nodePrev, nodeVel, nodeCount, params } = this;
    const lin = Math.exp(-params.linearDamping * h);

    // Finger force (v7): a push adds a velocity impulse to its patch along
    // -normal before integration, so the total force on the patch is
    // `push · W` and the material decides how deep it sinks.
    if (this.grabbed) this.applyHandPush(h);

    for (let i = 0; i < nodeCount; i++) {
      const i3 = i * 3;
      const vx = nodeVel[i3] * lin;
      const vy = nodeVel[i3 + 1] * lin;
      const vz = nodeVel[i3 + 2] * lin;
      nodeVel[i3] = vx;
      nodeVel[i3 + 1] = vy - params.gravity * h;
      nodeVel[i3 + 2] = vz;
      nodePrev[i3] = nodePos[i3];
      nodePrev[i3 + 1] = nodePos[i3 + 1];
      nodePrev[i3 + 2] = nodePos[i3 + 2];
      nodePos[i3] += vx * h;
      nodePos[i3 + 1] += (vy - params.gravity * h) * h;
      nodePos[i3 + 2] += vz * h;
    }

    const invH2 = 1 / (h * h);
    const alpha = params.edgeCompliance * invH2;
    this.solveEdges(alpha);
    this.solveWelds(alpha);
    this.solveVolumes(params.volumeCompliance * invH2);
    // Global volume constraint (round 11): runs once per substep right after the
    // per-tet volume pass, so the total volume cannot collapse under a deep
    // press even while individual tets are being deformed.
    this.solveGlobalVolume(params.volumeCompliance * invH2);
    if (this.grabbed) this.solveGrab();
    if (this.press.active) this.solvePress();
    // Every 2nd substep, an extra volume pass (and self-collision) after the
    // tool: a hard palm press or a grab pulling a patch would otherwise leave a
    // collapsed tetrahedron behind.
    if (this.substepCount % 2 === 0) {
      this.solveVolumes(params.volumeCompliance * invH2);
      this.solveCollisions();
    }
    this.substepCount += 1;
    this.solveFloorAndBounds(h);
    if (params.creepTime > 0) this.applyCreepDamping(h);
    // The volume constraint runs after the floor clamp as well, so the
    // tetrahedra are restored to a positive volume once the contact and bounds
    // have pushed nodes around.
    this.solveVolumes(params.volumeCompliance * invH2);
    // While three or more hands deform the body at once the base is held
    // against the floor and the surface is pulled in several directions at the
    // same time, which collapses the low tets; one more volume pass per substep
    // keeps them positive. The pass only helps while the hands are actually
    // moving the body (a hand holding still at its grab point deforms nothing),
    // so it is skipped otherwise, which keeps the desktop perf budget for five
    // idle hands. A single-hand pull or a palm press is left untouched so the
    // release curves and the drop tests keep their calibrated behaviour.
    let activeHands = 0;
    let deforming = false;
    for (let hi = 0; hi < this.hands.length; hi++) {
      const hand = this.hands[hi];
      if (!hand.active) continue;
      activeHands += 1;
      if (
        hand.push > 0 ||
        hand.target.x !== hand.origin.x ||
        hand.target.y !== hand.origin.y ||
        hand.target.z !== hand.origin.z
      ) {
        deforming = true;
      }
    }
    if (activeHands >= 3 && deforming) {
      for (let k = 0; k < 4; k++) this.solveVolumes(params.volumeCompliance * invH2);
    }
    // A palm press at its crush floor is the one gesture that can crush a whole
    // layer of tets at once. While the press is down there, extra per-tet volume
    // passes keep that layer from settling into an inverted state (the same
    // "reuse extra volume passes" trick the multi-hand path uses). The passes
    // only run at the floor and only while the press is active, so a normal
    // press keeps its calibrated recovery and the desktop perf budget for grabs
    // is unaffected.
    if (
      this.press.active &&
      this.press.y <= this.floorY + this.pressMinThickness + 0.5 * this.spacing
    ) {
      for (let k = 0; k < 8; k++) this.solveVolumes(params.volumeCompliance * invH2);
    }
    // Inversion recovery (round 11): force every inverted tet back to a positive
    // volume with zero compliance, up to 3 passes, after all the volume work for
    // this substep. This is the last correction before the velocity update, so a
    // crushed layer cannot stay inverted.
    let inverted = this.recoverInverted(3);
    if (!inverted && this.invertedCount > 0 && activeHands >= 2 && this.fingerLoad() > REFINE_LOAD) inverted = true;
    for (let k = 0; k < REFINE_MAX && inverted; k++) {
      this.solveEdges(alpha);
      this.solveVolumes(params.volumeCompliance * invH2);
      inverted = this.recoverInverted(3);
    }
    // Global shape matching is the elastic "memory" of the presets that recover
    // (slime has shapeRate 0 and keeps its plastic shape). It is off while a
    // gesture is active, so a held pull/press is never fought by the memory, and
    // after the last hand/press is released the effective rate ramps linearly
    // from 0 to `shapeRate` over CONFIG.feel.shapeRampSeconds. A released body
    // therefore rises smoothly instead of snapping. It runs after the volume
    // solve so the soft correction is not undone by it.
    if (this.grabbed || this.press.active) {
      this.shapeRamp = 0;
    } else if (this.shapeRamp < 1) {
      this.shapeRamp = Math.min(1, this.shapeRamp + h / CONFIG.feel.shapeRampSeconds);
    }
    if (params.shapeRate > 0 && this.shapeRamp > 1e-4) {
      this.solveShapeMatching(h, params.shapeRate * this.shapeRamp);
    }
    this.breakWelds();
    // Patch-level Coulomb static friction runs LAST, after every volume/shape
    // pass, so no later correction can reintroduce rigid in-plane drift.
    this.applyFloorStaticFriction(h);

    const maxSpeed = CONFIG.simulation.maxSpeed;
    for (let i = 0; i < nodeCount; i++) {
      const i3 = i * 3;
      let vx = (nodePos[i3] - nodePrev[i3]) / h;
      let vy = (nodePos[i3 + 1] - nodePrev[i3 + 1]) / h;
      let vz = (nodePos[i3 + 2] - nodePrev[i3 + 2]) / h;
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (speed > maxSpeed) {
        const scale = maxSpeed / speed;
        vx *= scale;
        vy *= scale;
        vz *= scale;
      }
      nodeVel[i3] = vx;
      nodeVel[i3 + 1] = vy;
      nodeVel[i3 + 2] = vz;
    }

    this.applyViscosity(params.viscosity);
    // Extra damping during recovery (slow-rising foam). It is applied only while
    // no gesture is active AND the body is grounded, so a held press/pull still
    // sinks freely and an airborne drop keeps its impact speed (the splat is
    // preserved), while the rise back to the settled shape is overdamped and
    // settles without wobble.
    if (params.viscoRelease > 0 && !this.grabbed && !this.press.active && this.contact.count > 0) {
      const vr = Math.exp(-params.viscoRelease * h);
      for (let i = 0; i < nodeCount; i++) {
        const i3 = i * 3;
        nodeVel[i3] *= vr;
        nodeVel[i3 + 1] *= vr;
        nodeVel[i3 + 2] *= vr;
      }
    }
    // Plastic flow only while the user is actively deforming the body, so the
    // rest shape does not creep back toward the relaxed pose and erase the
    // memory a soft preset is supposed to keep.
    if (params.plasticRate > 0 && (this.grabbed || this.press.active)) {
      this.applyPlasticity(h);
    }

    // Finger state and the per-substep signals the frame aggregates.
    if (this.grabbed) this.updateHandState(h);
    this.trackSubstepState();
  }

  /**
   * Distribute a hand's push force over its patch as a velocity impulse. With
   * node mass m_g = 1/invMass[g] and patch weight w_g, adding
   *   Δv_g = -normal · (push · W / Σ(w_g·m_g)) · w_g · h
   * to every patch node makes the total impulse on the patch `push · W · h`
   * along -normal, i.e. a net force of `push · W` (W = totalMass · gravity).
   */
  applyHandPush(h) {
    const { hands, nodeVel, invMass } = this;
    const W = this.totalMass * this.params.gravity;
    const gain = this.params.pushGain;
    for (let hi = 0; hi < hands.length; hi++) {
      const hand = hands[hi];
      if (!hand.active || hand.push <= 0) continue;
      let sumWM = 0;
      for (let g = 0; g < hand.count; g++) sumWM += hand.w[g] / invMass[hand.idx[g]];
      const n = hand.normal;
      const c = ((hand.push * gain * W) / sumWM) * h;
      for (let g = 0; g < hand.count; g++) {
        const i3 = hand.idx[g] * 3;
        const k = c * hand.w[g];
        nodeVel[i3] -= n.x * k;
        nodeVel[i3 + 1] -= n.y * k;
        nodeVel[i3 + 2] -= n.z * k;
      }
    }
  }

  /**
   * Per-substep hand state (v7): the low-passed sink depth and the patch centre
   * over the nodes with w >= 0.6. The 20 ms low-pass keeps solver jitter out of
   * the depth the audio layer reads; the centre is the finger proxy's anchor.
   */
  updateHandState(h) {
    const { hands, nodePos } = this;
    const tau = 0.02;
    const alpha = 1 - Math.exp(-h / tau);
    for (let hi = 0; hi < hands.length; hi++) {
      const hand = hands[hi];
      if (!hand.active) continue;
      const n = hand.normal;
      const target = hand.target;
      let wsum = 0;
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let dsum = 0;
      for (let g = 0; g < hand.count; g++) {
        const w = hand.w[g];
        if (w < 0.6) continue;
        const i3 = hand.idx[g] * 3;
        const gx = target.x + hand.off[g * 3];
        const gy = target.y + hand.off[g * 3 + 1];
        const gz = target.z + hand.off[g * 3 + 2];
        const d = (gx - nodePos[i3]) * n.x + (gy - nodePos[i3 + 1]) * n.y + (gz - nodePos[i3 + 2]) * n.z;
        dsum += w * d;
        sx += w * nodePos[i3];
        sy += w * nodePos[i3 + 1];
        sz += w * nodePos[i3 + 2];
        wsum += w;
      }
      hand.center.x = sx / wsum;
      hand.center.y = sy / wsum;
      hand.center.z = sz / wsum;
      const before = hand.depth;
      hand.depth += (dsum / wsum - hand.depth) * alpha;
      this.depthRateSum += (hand.depth - before) / h;
    }
  }

  /**
   * Per-substep bookkeeping for the feedback signals: floor-contact count and
   * the node-centroid vertical speed. A 0 -> >0 contact transition during a
   * frame records the downward speed of the substep just before first contact.
   */
  trackSubstepState() {
    const { nodePos, nodeVel, nodeCount } = this;
    const limit = this.floorY + FLOOR_CONTACT_EPS;
    let contact = 0;
    let vy = 0;
    for (let i = 0; i < nodeCount; i++) {
      const i3 = i * 3;
      if (nodePos[i3 + 1] <= limit) contact += 1;
      vy += nodeVel[i3 + 1];
    }
    vy /= nodeCount;
    if (this.prevFloorContactCount === 0 && contact > 0) {
      const speed = -this.prevCentroidVelY;
      this.impactPending = speed > 0 ? speed : 0;
    }
    this.prevFloorContactCount = contact;
    this.prevCentroidVelY = vy;
    this.stepsSinceUpdate += 1;
  }

  /** XPBD distance constraints over the tet edges. `alpha` = compliance / h². */
  solveEdges(alpha) {
    const { edges, edgeRest, nodePos, invMass } = this;
    for (let k = 0; k < edgeRest.length; k++) {
      const i = edges[2 * k];
      const j = edges[2 * k + 1];
      const i3 = i * 3;
      const j3 = j * 3;
      const dx = nodePos[i3] - nodePos[j3];
      const dy = nodePos[i3 + 1] - nodePos[j3 + 1];
      const dz = nodePos[i3 + 2] - nodePos[j3 + 2];
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (length < 1e-9) continue;
      const wi = invMass[i];
      const wj = invMass[j];
      const w = wi + wj;
      if (w === 0) continue;
      const s = -(length - edgeRest[k]) / (w + alpha) / length;
      const cx = dx * s;
      const cy = dy * s;
      const cz = dz * s;
      nodePos[i3] += cx * wi;
      nodePos[i3 + 1] += cy * wi;
      nodePos[i3 + 2] += cz * wi;
      nodePos[j3] -= cx * wj;
      nodePos[j3 + 1] -= cy * wj;
      nodePos[j3 + 2] -= cz * wj;
    }
  }

  /**
   * Kelvin-Voigt creep damping (memory foam). The solved substep displacement
   * is split into the best-fit rigid motion (translation + rotation, Procrustes
   * between the substep start and the solved positions) and the deformation
   * left over; only the deformation is divided by `1 + creepTime / h`. Rigid
   * motion, free fall and any static state (no net displacement) are therefore
   * untouched, while a deformation can advance at a rate limited by
   * `creepTime` regardless of the force driving it: resistance proportional to
   * strain rate, i.e. a dashpot in parallel with the elastic constraints. The
   * limit is applied to the solved result, so the elastic response is not
   * weakened (a stateless per-substep solve cannot carry a damped constraint
   * without losing static stiffness).
   */
  applyCreepDamping(h) {
    const { nodePos, nodePrev, nodeCount, floorY, creepQuat } = this;
    const keep = 1 / (1 + this.params.creepTime / h);
    let cpx = 0;
    let cpy = 0;
    let cpz = 0;
    let csx = 0;
    let csy = 0;
    let csz = 0;
    for (let i = 0; i < nodeCount; i++) {
      const i3 = i * 3;
      cpx += nodePrev[i3];
      cpy += nodePrev[i3 + 1];
      cpz += nodePrev[i3 + 2];
      csx += nodePos[i3];
      csy += nodePos[i3 + 1];
      csz += nodePos[i3 + 2];
    }
    cpx /= nodeCount;
    cpy /= nodeCount;
    cpz /= nodeCount;
    csx /= nodeCount;
    csy /= nodeCount;
    csz /= nodeCount;
    const A = this.creepA;
    A.fill(0);
    for (let i = 0; i < nodeCount; i++) {
      const i3 = i * 3;
      const px = nodePos[i3] - csx;
      const py = nodePos[i3 + 1] - csy;
      const pz = nodePos[i3 + 2] - csz;
      const qx = nodePrev[i3] - cpx;
      const qy = nodePrev[i3 + 1] - cpy;
      const qz = nodePrev[i3 + 2] - cpz;
      A[0] += px * qx;
      A[1] += px * qy;
      A[2] += px * qz;
      A[3] += py * qx;
      A[4] += py * qy;
      A[5] += py * qz;
      A[6] += pz * qx;
      A[7] += pz * qy;
      A[8] += pz * qz;
    }
    creepQuat[0] = 0;
    creepQuat[1] = 0;
    creepQuat[2] = 0;
    creepQuat[3] = 1;
    const R = extractRotation(A, creepQuat, 3);
    for (let i = 0; i < nodeCount; i++) {
      const i3 = i * 3;
      const qx = nodePrev[i3] - cpx;
      const qy = nodePrev[i3 + 1] - cpy;
      const qz = nodePrev[i3 + 2] - cpz;
      const rx = R[0] * qx + R[1] * qy + R[2] * qz + csx;
      const ry = R[3] * qx + R[4] * qy + R[5] * qz + csy;
      const rz = R[6] * qx + R[7] * qy + R[8] * qz + csz;
      nodePos[i3] = rx + (nodePos[i3] - rx) * keep;
      let y = ry + (nodePos[i3 + 1] - ry) * keep;
      // The floor contact is a constraint, not deformation: a node resting on
      // the table stays on it (unless the base is being peeled) and nothing
      // sinks through it.
      if (y < floorY || (!this.peeling && nodePrev[i3 + 1] <= floorY + FLOOR_CONTACT_EPS)) y = floorY;
      nodePos[i3 + 1] = y;
      nodePos[i3 + 2] = rz + (nodePos[i3 + 2] - rz) * keep;
    }
  }

  /**
   * XPBD tet-volume constraints. `alpha` = compliance / h². The four gradients
   * are the cross products of the edge vectors divided by 6, unrolled here with
   * the four vertex positions cached in locals — this is the hot loop.
   */
  solveVolumes(alpha) {
    const { tets, tetRest0, tetCount, nodePos, invMass } = this;
    let inverted = 0;
    let minRatio = Infinity;
    for (let t = 0; t < tetCount; t++) {
      const b = t * 4;
      const n0 = tets[b];
      const n1 = tets[b + 1];
      const n2 = tets[b + 2];
      const n3 = tets[b + 3];
      const i0 = n0 * 3;
      const i1 = n1 * 3;
      const i2 = n2 * 3;
      const i3 = n3 * 3;
      const p0x = nodePos[i0];
      const p0y = nodePos[i0 + 1];
      const p0z = nodePos[i0 + 2];
      const e1x = nodePos[i1] - p0x;
      const e1y = nodePos[i1 + 1] - p0y;
      const e1z = nodePos[i1 + 2] - p0z;
      const e2x = nodePos[i2] - p0x;
      const e2y = nodePos[i2 + 1] - p0y;
      const e2z = nodePos[i2 + 2] - p0z;
      const e3x = nodePos[i3] - p0x;
      const e3y = nodePos[i3 + 1] - p0y;
      const e3z = nodePos[i3 + 2] - p0z;

      // g0 = cross(p3-p1, p2-p1)/6 ; g1 = cross(e2,e3)/6 ;
      // g2 = cross(e3,e1)/6 ; g3 = cross(e1,e2)/6
      const u0x = e3x - e1x;
      const u0y = e3y - e1y;
      const u0z = e3z - e1z;
      const v0x = e2x - e1x;
      const v0y = e2y - e1y;
      const v0z = e2z - e1z;
      const g0x = (u0y * v0z - u0z * v0y) / 6;
      const g0y = (u0z * v0x - u0x * v0z) / 6;
      const g0z = (u0x * v0y - u0y * v0x) / 6;
      const g1x = (e2y * e3z - e2z * e3y) / 6;
      const g1y = (e2z * e3x - e2x * e3z) / 6;
      const g1z = (e2x * e3y - e2y * e3x) / 6;
      const g2x = (e3y * e1z - e3z * e1y) / 6;
      const g2y = (e3z * e1x - e3x * e1z) / 6;
      const g2z = (e3x * e1y - e3y * e1x) / 6;
      const g3x = (e1y * e2z - e1z * e2y) / 6;
      const g3y = (e1z * e2x - e1x * e2z) / 6;
      const g3z = (e1x * e2y - e1y * e2x) / 6;

      const im0 = invMass[n0];
      const im1 = invMass[n1];
      const im2 = invMass[n2];
      const im3 = invMass[n3];
      const w =
        im0 * (g0x * g0x + g0y * g0y + g0z * g0z) +
        im1 * (g1x * g1x + g1y * g1y + g1z * g1z) +
        im2 * (g2x * g2x + g2y * g2y + g2z * g2z) +
        im3 * (g3x * g3x + g3y * g3y + g3z * g3z);
      if (w === 0) continue;

      const volume = (e1x * g1x + e1y * g1y + e1z * g1z) / 1;
      if (volume <= 0) inverted += 1;
      const ratio = volume / tetRest0[t];
      if (ratio < minRatio) minRatio = ratio;
      const s = -(volume - tetRest0[t]) / (w + alpha);

      nodePos[i0] += g0x * s * im0;
      nodePos[i0 + 1] += g0y * s * im0;
      nodePos[i0 + 2] += g0z * s * im0;
      nodePos[i1] += g1x * s * im1;
      nodePos[i1 + 1] += g1y * s * im1;
      nodePos[i1 + 2] += g1z * s * im1;
      nodePos[i2] += g2x * s * im2;
      nodePos[i2 + 1] += g2y * s * im2;
      nodePos[i2 + 2] += g2z * s * im2;
      nodePos[i3] += g3x * s * im3;
      nodePos[i3 + 1] += g3y * s * im3;
      nodePos[i3 + 2] += g3z * s * im3;
    }
    // Recorded so `recoverInverted` can skip its own scan when the last volume
    // pass saw no inverted or badly squeezed tet (the common case), keeping the
    // perf budget.
    this.invertedCount = inverted;
    this.minTetRatio = minRatio;
  }

  /**
   * Global volume constraint (round 11). One XPBD constraint on the TOTAL signed
   * tet volume with target `Σ tetRest0` and the same compliance as the per-tet
   * pass. The gradient at a node is the sum of the per-tet volume gradients of
   * the tets that contain it. The per-tet pass keeps every tet near its own rest
   * volume; this extra constraint makes the SUM rigid, so a deep palm press can
   * compress the body locally but never let it lose its total volume (the
   * browser collapse). `alpha` = compliance / h².
   *
   * It is a one-sided (inequality) constraint: the correction only fires when the
   * total volume has dropped BELOW the target, which is the collapse case. A
   * stretch that pushes the total volume above the target is left alone, so the
   * calibrated release/press curves and the plastic slime spread keep their
   * behaviour. "Volume can still compress locally, never globally."
   */
  solveGlobalVolume(alpha) {
    const { tets, tetCount, nodePos, invMass, volumeGrad, nodeCount, totalRestVolume } = this;
    volumeGrad.fill(0);
    let volume = 0;
    for (let t = 0; t < tetCount; t++) {
      const b = t * 4;
      const n0 = tets[b];
      const n1 = tets[b + 1];
      const n2 = tets[b + 2];
      const n3 = tets[b + 3];
      const i0 = n0 * 3;
      const i1 = n1 * 3;
      const i2 = n2 * 3;
      const i3 = n3 * 3;
      const p0x = nodePos[i0];
      const p0y = nodePos[i0 + 1];
      const p0z = nodePos[i0 + 2];
      const e1x = nodePos[i1] - p0x;
      const e1y = nodePos[i1 + 1] - p0y;
      const e1z = nodePos[i1 + 2] - p0z;
      const e2x = nodePos[i2] - p0x;
      const e2y = nodePos[i2 + 1] - p0y;
      const e2z = nodePos[i2 + 2] - p0z;
      const e3x = nodePos[i3] - p0x;
      const e3y = nodePos[i3 + 1] - p0y;
      const e3z = nodePos[i3 + 2] - p0z;

      const u0x = e3x - e1x;
      const u0y = e3y - e1y;
      const u0z = e3z - e1z;
      const v0x = e2x - e1x;
      const v0y = e2y - e1y;
      const v0z = e2z - e1z;
      const g0x = (u0y * v0z - u0z * v0y) / 6;
      const g0y = (u0z * v0x - u0x * v0z) / 6;
      const g0z = (u0x * v0y - u0y * v0x) / 6;
      const g1x = (e2y * e3z - e2z * e3y) / 6;
      const g1y = (e2z * e3x - e2x * e3z) / 6;
      const g1z = (e2x * e3y - e2y * e3x) / 6;
      const g2x = (e3y * e1z - e3z * e1y) / 6;
      const g2y = (e3z * e1x - e3x * e1z) / 6;
      const g2z = (e3x * e1y - e3y * e1x) / 6;
      const g3x = (e1y * e2z - e1z * e2y) / 6;
      const g3y = (e1z * e2x - e1x * e2z) / 6;
      const g3z = (e1x * e2y - e1y * e2x) / 6;

      volume += e1x * g1x + e1y * g1y + e1z * g1z;
      volumeGrad[i0] += g0x;
      volumeGrad[i0 + 1] += g0y;
      volumeGrad[i0 + 2] += g0z;
      volumeGrad[i1] += g1x;
      volumeGrad[i1 + 1] += g1y;
      volumeGrad[i1 + 2] += g1z;
      volumeGrad[i2] += g2x;
      volumeGrad[i2 + 1] += g2y;
      volumeGrad[i2 + 2] += g2z;
      volumeGrad[i3] += g3x;
      volumeGrad[i3 + 1] += g3y;
      volumeGrad[i3 + 2] += g3z;
    }

    let w = 0;
    for (let i = 0; i < nodeCount; i++) {
      const im = invMass[i];
      if (im === 0) continue;
      const i3 = i * 3;
      const gx = volumeGrad[i3];
      const gy = volumeGrad[i3 + 1];
      const gz = volumeGrad[i3 + 2];
      w += im * (gx * gx + gy * gy + gz * gz);
    }
    if (w === 0) return;
    // One-sided: only a global volume DROP (collapse) is corrected.
    if (volume >= totalRestVolume) return;
    const s = -(volume - totalRestVolume) / (w + alpha);
    for (let i = 0; i < nodeCount; i++) {
      const im = invMass[i];
      if (im === 0) continue;
      const i3 = i * 3;
      nodePos[i3] += volumeGrad[i3] * s * im;
      nodePos[i3 + 1] += volumeGrad[i3 + 1] * s * im;
      nodePos[i3 + 2] += volumeGrad[i3 + 2] * s * im;
    }
  }

  /**
   * Inversion recovery (round 11). After the volume passes, every tet whose
   * signed volume is <= 0 is re-solved with zero compliance (alpha 0), up to
   * `iterations` times, correcting only the inverted tets. A tet crushed by a
   * deep press is forced back to a positive volume instead of staying collapsed;
   * the pass stops early once no tet is inverted.
   */
  recoverInverted(iterations) {
    // Skip the scan when the last volume pass saw no inverted and no badly
    // squeezed tet (a Gauss-Seidel pass can leave a squeezed tet inverted).
    if (this.invertedCount === 0 && this.minTetRatio > RECOVER_SCAN_RATIO) return false;
    const { tets, tetRest0, tetCount, nodePos, invMass } = this;
    let any = false;
    for (let it = 0; it < iterations; it++) {
      any = false;
      for (let t = 0; t < tetCount; t++) {
        const b = t * 4;
        const n0 = tets[b];
        const n1 = tets[b + 1];
        const n2 = tets[b + 2];
        const n3 = tets[b + 3];
        const i0 = n0 * 3;
        const i1 = n1 * 3;
        const i2 = n2 * 3;
        const i3 = n3 * 3;
        const p0x = nodePos[i0];
        const p0y = nodePos[i0 + 1];
        const p0z = nodePos[i0 + 2];
        const e1x = nodePos[i1] - p0x;
        const e1y = nodePos[i1 + 1] - p0y;
        const e1z = nodePos[i1 + 2] - p0z;
        const e2x = nodePos[i2] - p0x;
        const e2y = nodePos[i2 + 1] - p0y;
        const e2z = nodePos[i2 + 2] - p0z;
        const e3x = nodePos[i3] - p0x;
        const e3y = nodePos[i3 + 1] - p0y;
        const e3z = nodePos[i3 + 2] - p0z;

        const u0x = e3x - e1x;
        const u0y = e3y - e1y;
        const u0z = e3z - e1z;
        const v0x = e2x - e1x;
        const v0y = e2y - e1y;
        const v0z = e2z - e1z;
        const g0x = (u0y * v0z - u0z * v0y) / 6;
        const g0y = (u0z * v0x - u0x * v0z) / 6;
        const g0z = (u0x * v0y - u0y * v0x) / 6;
        const g1x = (e2y * e3z - e2z * e3y) / 6;
        const g1y = (e2z * e3x - e2x * e3z) / 6;
        const g1z = (e2x * e3y - e2y * e3x) / 6;
        const g2x = (e3y * e1z - e3z * e1y) / 6;
        const g2y = (e3z * e1x - e3x * e1z) / 6;
        const g2z = (e3x * e1y - e3y * e1x) / 6;
        const g3x = (e1y * e2z - e1z * e2y) / 6;
        const g3y = (e1z * e2x - e1x * e2z) / 6;
        const g3z = (e1x * e2y - e1y * e2x) / 6;

        const volume = e1x * g1x + e1y * g1y + e1z * g1z;
        if (volume > 0) continue;
        any = true;

        const im0 = invMass[n0];
        const im1 = invMass[n1];
        const im2 = invMass[n2];
        const im3 = invMass[n3];
        const w =
          im0 * (g0x * g0x + g0y * g0y + g0z * g0z) +
          im1 * (g1x * g1x + g1y * g1y + g1z * g1z) +
          im2 * (g2x * g2x + g2y * g2y + g2z * g2z) +
          im3 * (g3x * g3x + g3y * g3y + g3z * g3z);
        if (w === 0) continue;
        const s = -(volume - tetRest0[t]) / w;

        nodePos[i0] += g0x * s * im0;
        nodePos[i0 + 1] += g0y * s * im0;
        nodePos[i0 + 2] += g0z * s * im0;
        nodePos[i1] += g1x * s * im1;
        nodePos[i1 + 1] += g1y * s * im1;
        nodePos[i1 + 2] += g1z * s * im1;
        nodePos[i2] += g2x * s * im2;
        nodePos[i2 + 1] += g2y * s * im2;
        nodePos[i2 + 2] += g2z * s * im2;
        nodePos[i3] += g3x * s * im3;
        nodePos[i3 + 1] += g3y * s * im3;
        nodePos[i3 + 2] += g3z * s * im3;
      }
      if (!any) break;
    }
    return any;
  }

  /**
   * Müller 2005 global shape matching on the NODES. The best-fit rigid transform
   * of the rest frame (node rest positions minus their centroid) is found with
   * Müller 2016 iterative rotation extraction, warm-started from the previous
   * substep, then every node is moved a fraction `beta` of the way to its goal.
   * `beta = 1 − exp(−shapeRate·h)` keeps the correction frame-rate independent
   * and soft enough that a held pull or press is not fought by the memory.
   */
  solveShapeMatching(h, rate) {
    const { nodePos, nodeCount, shapeA } = this;
    const goalLocal = this.shapeGoalLocal;
    let cmx = 0;
    let cmy = 0;
    let cmz = 0;
    for (let i = 0; i < nodeCount; i++) {
      const i3 = i * 3;
      cmx += nodePos[i3];
      cmy += nodePos[i3 + 1];
      cmz += nodePos[i3 + 2];
    }
    cmx /= nodeCount;
    cmy /= nodeCount;
    cmz /= nodeCount;

    shapeA.fill(0);
    for (let i = 0; i < nodeCount; i++) {
      const i3 = i * 3;
      const px = nodePos[i3] - cmx;
      const py = nodePos[i3 + 1] - cmy;
      const pz = nodePos[i3 + 2] - cmz;
      const qx = goalLocal[i3];
      const qy = goalLocal[i3 + 1];
      const qz = goalLocal[i3 + 2];
      shapeA[0] += px * qx;
      shapeA[1] += px * qy;
      shapeA[2] += px * qz;
      shapeA[3] += py * qx;
      shapeA[4] += py * qy;
      shapeA[5] += py * qz;
      shapeA[6] += pz * qx;
      shapeA[7] += pz * qy;
      shapeA[8] += pz * qz;
    }

    const R = extractRotation(shapeA, this.shapeMatchQuat, 4);
    const beta = 1 - Math.exp(-rate * h);
    for (let i = 0; i < nodeCount; i++) {
      const i3 = i * 3;
      const qx = goalLocal[i3];
      const qy = goalLocal[i3 + 1];
      const qz = goalLocal[i3 + 2];
      const gx = R[0] * qx + R[1] * qy + R[2] * qz + cmx;
      const gy = R[3] * qx + R[4] * qy + R[5] * qz + cmy;
      const gz = R[6] * qx + R[7] * qy + R[8] * qz + cmz;
      nodePos[i3] += (gx - nodePos[i3]) * beta;
      nodePos[i3 + 1] += (gy - nodePos[i3 + 1]) * beta;
      nodePos[i3 + 2] += (gz - nodePos[i3 + 2]) * beta;
    }
  }

  /**
   * Capture the current node frame (centred on its centroid) as the
   * shape-matching goal. Called once the body has settled after a reset.
   */
  captureShapeGoal() {
    const { nodePos, nodeCount, shapeGoalLocal } = this;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < nodeCount; i++) {
      const i3 = i * 3;
      cx += nodePos[i3];
      cy += nodePos[i3 + 1];
      cz += nodePos[i3 + 2];
    }
    cx /= nodeCount;
    cy /= nodeCount;
    cz /= nodeCount;
    for (let i = 0; i < nodeCount; i++) {
      const i3 = i * 3;
      shapeGoalLocal[i3] = nodePos[i3] - cx;
      shapeGoalLocal[i3 + 1] = nodePos[i3 + 1] - cy;
      shapeGoalLocal[i3 + 2] = nodePos[i3 + 2] - cz;
    }
    this.shapeMatchQuat[0] = 0;
    this.shapeMatchQuat[1] = 0;
    this.shapeMatchQuat[2] = 0;
    this.shapeMatchQuat[3] = 1;
  }

  solveGrab() {
    const { hands } = this;
    let active = 0;
    for (let h = 0; h < hands.length; h++) if (hands[h].active) active += 1;
    // A single hand keeps the original per-node relaxation byte-for-byte, so the
    // calibrated single-hand release/press curves and knead behaviour are
    // untouched. Two or more hands may share nodes, so they go through the
    // weight-averaged solve below.
    if (active <= 1) {
      this.solveGrabSingle();
      return;
    }
    this.solveGrabAveraged();
  }

  /**
   * Single-hand relaxation. The pin correction is split into its component
   * along the hand normal and the tangential rest (v7): the tangential part is
   * applied exactly as before, while the normal part is scaled by
   * `1 - pushBlend` so a pushing finger lets the material decide the depth and
   * the pin takes over smoothly as the pointer fades the push out during a pull.
   */
  solveGrabSingle() {
    const { nodePos, hands } = this;
    const stiffness = this.params.grabStiffness;
    const freeForce = CONFIG.grab.pull.push.freeForce;
    const gain = this.params.pushGain;
    for (let h = 0; h < hands.length; h++) {
      const hand = hands[h];
      if (!hand.active) continue;
      const target = hand.target;
      const n = hand.normal;
      const pushBlend = clamp((hand.push * gain) / freeForce, 0, 1);
      for (let g = 0; g < hand.count; g++) {
        const i3 = hand.idx[g] * 3;
        const f = Math.min(1, stiffness * hand.w[g]);
        let dx = target.x + hand.off[g * 3] - nodePos[i3];
        let dy = target.y + hand.off[g * 3 + 1] - nodePos[i3 + 1];
        let dz = target.z + hand.off[g * 3 + 2] - nodePos[i3 + 2];
        if (pushBlend > 0) {
          const release = pushBlend * (dx * n.x + dy * n.y + dz * n.z);
          dx -= release * n.x;
          dy -= release * n.y;
          dz -= release * n.z;
        }
        nodePos[i3] += dx * f;
        nodePos[i3 + 1] += dy * f;
        nodePos[i3 + 2] += dz * f;
      }
    }
  }

  /**
   * Overlapping hand patches share nodes. Applying the hands one after the
   * other lets the last hand win and the others fight it, which drags a shared
   * node in contradictory directions and inverts the tets underneath (the
   * browser five-finger failure). Instead every node is moved once toward the
   * weight-averaged target of the hands that touch it, with the correction
   * capped at full stiffness so a cluster of hands cannot move a shared node
   * more than the solver would for a single hand.
   *
   * Each hand's normal component is released by its own `pushBlend` (v7) before
   * the average, so a cluster of pushing fingers leaves the shared nodes free
   * along their own normals while their tangential pull still blends.
   */
  solveGrabAveraged() {
    const { nodePos, hands, grabAccum, grabWeight, grabTouched, grabRelease } = this;
    const stiffness = this.params.grabStiffness;
    const freeForce = CONFIG.grab.pull.push.freeForce;
    const gain = this.params.pushGain;
    let touchedCount = 0;
    for (let h = 0; h < hands.length; h++) {
      const hand = hands[h];
      if (!hand.active) continue;
      const target = hand.target;
      const n = hand.normal;
      const pushBlend = clamp((hand.push * gain) / freeForce, 0, 1);
      for (let g = 0; g < hand.count; g++) {
        const node = hand.idx[g];
        const i3 = node * 3;
        const f = Math.min(1, stiffness * hand.w[g]);
        const gx = target.x + hand.off[g * 3];
        const gy = target.y + hand.off[g * 3 + 1];
        const gz = target.z + hand.off[g * 3 + 2];
        if (grabWeight[node] === 0) grabTouched[touchedCount++] = node;
        grabAccum[i3] += f * gx;
        grabAccum[i3 + 1] += f * gy;
        grabAccum[i3 + 2] += f * gz;
        if (pushBlend > 0) {
          const dn = (gx - nodePos[i3]) * n.x + (gy - nodePos[i3 + 1]) * n.y + (gz - nodePos[i3 + 2]) * n.z;
          const k = f * pushBlend * dn;
          grabRelease[i3] += k * n.x;
          grabRelease[i3 + 1] += k * n.y;
          grabRelease[i3 + 2] += k * n.z;
        }
        grabWeight[node] += f;
      }
    }
    for (let k = 0; k < touchedCount; k++) {
      const node = grabTouched[k];
      const i3 = node * 3;
      const wsum = grabWeight[node];
      // The correction is capped at full stiffness, so no cluster of hands can
      // pull a shared node more than the solver would for a single hand.
      const blend = wsum > 1 ? 1 : wsum;
      const inv = 1 / wsum;
      const tx = (grabAccum[i3] - grabRelease[i3]) * inv;
      const ty = (grabAccum[i3 + 1] - grabRelease[i3 + 1]) * inv;
      const tz = (grabAccum[i3 + 2] - grabRelease[i3 + 2]) * inv;
      nodePos[i3] += (tx - nodePos[i3]) * blend;
      nodePos[i3 + 1] += (ty - nodePos[i3 + 1]) * blend;
      nodePos[i3 + 2] += (tz - nodePos[i3 + 2]) * blend;
      grabWeight[node] = 0;
      grabAccum[i3] = 0;
      grabAccum[i3 + 1] = 0;
      grabAccum[i3 + 2] = 0;
      grabRelease[i3] = 0;
      grabRelease[i3 + 1] = 0;
      grabRelease[i3 + 2] = 0;
    }
  }

  /** XPBD distance constraints over the fused welds. `alpha` = compliance / h². */
  solveWelds(alpha) {
    const { weldA, weldB, weldRest, weldCount, nodePos, invMass } = this;
    for (let w = 0; w < weldCount; w++) {
      const i = weldA[w];
      const j = weldB[w];
      const i3 = i * 3;
      const j3 = j * 3;
      const dx = nodePos[i3] - nodePos[j3];
      const dy = nodePos[i3 + 1] - nodePos[j3 + 1];
      const dz = nodePos[i3 + 2] - nodePos[j3 + 2];
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (length < 1e-9) continue;
      const wi = invMass[i];
      const wj = invMass[j];
      const sum = wi + wj;
      if (sum === 0) continue;
      const s = -(length - weldRest[w]) / (sum + alpha) / length;
      const cx = dx * s;
      const cy = dy * s;
      const cz = dz * s;
      nodePos[i3] += cx * wi;
      nodePos[i3 + 1] += cy * wi;
      nodePos[i3 + 2] += cz * wi;
      nodePos[j3] -= cx * wj;
      nodePos[j3 + 1] -= cy * wj;
      nodePos[j3 + 2] -= cz * wj;
    }
  }

  /** Spatial-hash bucket for an integer grid cell. */
  hashCell(cx, cy, cz) {
    let h = Math.imul(cx, 0x9e3779b1);
    h ^= Math.imul(cy, 0x85ebca77);
    h ^= Math.imul(cz, 0xc2b2ae3d);
    return (h >>> 0) & (this.hashCap - 1);
  }

  /**
   * Self-collision + fusion over boundary nodes. A pair collides when the nodes
   * are closer than `collideDist` in space but farther than `restFar` apart in
   * the material — that is a fold, not a neighbour. The pair is pushed apart
   * with inverse-mass weights; when the preset fuses, it becomes a weld.
   */
  solveCollisions() {
    const {
      boundaryCount,
      boundaryNodes,
      nodePos,
      nodeRest,
      invMass,
      collideDist,
      restFar,
      hashHead,
      hashNext,
      cellX,
      cellY,
      cellZ,
    } = this;
    if (boundaryCount === 0) {
      this.collisions = 0;
      return;
    }
    const invCell = 1 / collideDist;
    hashHead.fill(-1);
    for (let b = 0; b < boundaryCount; b++) {
      const n3 = boundaryNodes[b] * 3;
      const cx = Math.floor(nodePos[n3] * invCell);
      const cy = Math.floor(nodePos[n3 + 1] * invCell);
      const cz = Math.floor(nodePos[n3 + 2] * invCell);
      cellX[b] = cx;
      cellY[b] = cy;
      cellZ[b] = cz;
      const slot = this.hashCell(cx, cy, cz);
      hashNext[b] = hashHead[slot];
      hashHead[slot] = b;
    }

    const collideSq = collideDist * collideDist;
    const restFarSq = restFar * restFar;
    const fuse = this.params.fuse;
    const maxWelds = this.maxWelds;
    let pairs = 0;
    for (let b = 0; b < boundaryCount; b++) {
      const n = boundaryNodes[b];
      const n3 = n * 3;
      const x = nodePos[n3];
      const y = nodePos[n3 + 1];
      const z = nodePos[n3 + 2];
      const bx = cellX[b];
      const by = cellY[b];
      const bz = cellZ[b];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const slot = this.hashCell(bx + dx, by + dy, bz + dz);
            for (let c = hashHead[slot]; c !== -1; c = hashNext[c]) {
              if (c <= b) continue;
              if (cellX[c] !== bx + dx || cellY[c] !== by + dy || cellZ[c] !== bz + dz) continue;
              const m = boundaryNodes[c];
              const m3 = m * 3;
              const ddx = nodePos[m3] - x;
              const ddy = nodePos[m3 + 1] - y;
              const ddz = nodePos[m3 + 2] - z;
              const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
              if (d2 >= collideSq) continue;
              const rdx = nodeRest[m3] - nodeRest[n3];
              const rdy = nodeRest[m3 + 1] - nodeRest[n3 + 1];
              const rdz = nodeRest[m3 + 2] - nodeRest[n3 + 2];
              if (rdx * rdx + rdy * rdy + rdz * rdz <= restFarSq) continue;
              const wi = invMass[n];
              const wj = invMass[m];
              const wsum = wi + wj;
              if (wsum === 0) continue;
              const dist = Math.sqrt(d2);
              if (dist > 1e-9) {
                // Push apart, but only by a fraction of the overlap per pass so a
                // deep overlap cannot fling a node across a tet and invert it;
                // repeated passes (every 2nd substep) fully separate the pair.
                const overlap = Math.min(collideDist - dist, this.collideRelax * collideDist);
                const correction = overlap / dist / wsum;
                const ux = ddx * correction;
                const uy = ddy * correction;
                const uz = ddz * correction;
                nodePos[n3] += ux * wi;
                nodePos[n3 + 1] += uy * wi;
                nodePos[n3 + 2] += uz * wi;
                nodePos[m3] -= ux * wj;
                nodePos[m3 + 1] -= uy * wj;
                nodePos[m3 + 2] -= uz * wj;
              }
              pairs += 1;
              if (fuse > 0 && this.weldCount < maxWelds) {
                this.addWeld(n, m, collideDist);
              }
            }
          }
        }
      }
    }
    this.collisions = pairs;
  }

  /** Add a weld unless the pair is already welded. */
  addWeld(i, j, restLength) {
    const lo = i < j ? i : j;
    const hi = i < j ? j : i;
    const key = lo * this.nodeCount + hi;
    if (this.weldSet.has(key)) return;
    const w = this.weldCount;
    this.weldSet.add(key);
    this.weldA[w] = i;
    this.weldB[w] = j;
    this.weldRest0[w] = restLength;
    this.weldRest[w] = restLength;
    this.weldLprev[w] = restLength;
    this.weldAge[w] = 0;
    this.weldCount = w + 1;
  }

  /** Swap-remove the weld at slot `w`. */
  removeWeldAt(w) {
    const a = this.weldA[w];
    const b = this.weldB[w];
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    this.weldSet.delete(lo * this.nodeCount + hi);
    const last = this.weldCount - 1;
    if (w !== last) {
      this.weldA[w] = this.weldA[last];
      this.weldB[w] = this.weldB[last];
      this.weldRest0[w] = this.weldRest0[last];
      this.weldRest[w] = this.weldRest[last];
      this.weldLprev[w] = this.weldLprev[last];
      this.weldAge[w] = this.weldAge[last];
    }
    this.weldCount = last;
  }

  /** Snap welds stretched past `params.weldBreak` × their rest length. */
  breakWelds() {
    const { weldA, weldB, weldRest, weldCount, nodePos } = this;
    const breakFactor = this.params.weldBreak;
    for (let w = weldCount - 1; w >= 0; w--) {
      const i3 = weldA[w] * 3;
      const j3 = weldB[w] * 3;
      const length = Math.hypot(
        nodePos[j3] - nodePos[i3],
        nodePos[j3 + 1] - nodePos[i3 + 1],
        nodePos[j3 + 2] - nodePos[i3 + 2]
      );
      if (length > breakFactor * weldRest[w]) {
        this.removeWeldAt(w);
        this.weldBreaksSinceUpdate += 1;
      }
    }
  }

  /**
   * Weld lifetime (round 7). Temporary stickiness must not hold a fold forever:
   * while no hand and no press is active, every weld of a non-plastic preset
   * (`plasticRate === 0`) ages, and once it is older than `params.weldLife`
   * seconds it is removed so the elastic edges can pull the body back to its
   * rest shape. A plastic preset (slime) never expires its welds.
   */
  ageWelds(dt) {
    if (this.params.plasticRate !== 0) return;
    const life = this.params.weldLife;
    for (let w = this.weldCount - 1; w >= 0; w--) {
      this.weldAge[w] += dt;
      if (this.weldAge[w] >= life) this.removeWeldAt(w);
    }
  }

  solvePress() {
    const { nodePos, press, nodeCount } = this;
    const invR = 1 / press.radius;
    for (let i = 0; i < nodeCount; i++) {
      const i3 = i * 3;
      const dx = nodePos[i3] - press.x;
      const dz = nodePos[i3 + 2] - press.z;
      const t = Math.sqrt(dx * dx + dz * dz) * invR;
      if (t >= 1 || nodePos[i3 + 1] <= press.y) continue;
      const k = t < 0.6 ? 1 : 1 - smoothstep(0.6, 1.0, t);
      nodePos[i3 + 1] += (press.y - nodePos[i3 + 1]) * k;
    }
  }

  /**
   * Floor contact and world bounds. Per node, a contact node stays stuck only
   * while its per-substep tangential displacement is below
   * `muStatic * penetration + tack`, where the `tack` term (`tackBreak * h`)
   * applies only while a tool is active; otherwise it slips by the kinetic
   * fraction. The patch as a whole is held by the force-based Coulomb limit in
   * `applyFloorStaticFriction`, which runs at the end of the substep. A palm
   * press lets the contact spread outward, and a strong upward grab peels the
   * whole contact off the table. The ceiling and the horizontal radius bound
   * always apply.
   */
  solveFloorAndBounds(h) {
    const { nodePos, nodePrev, nodeCount, floorY, contactIdx } = this;
    const toolActive = this.grabbed || this.press.active;
    const muStatic = this.params.staticFriction;
    const boundsRadius = CONFIG.simulation.boundsRadius;
    const top = CONFIG.simulation.ceiling;
    const tack = toolActive ? this.params.tackBreak * h : 0;
    const fastSlip = CONFIG.simulation.fastSlip;
    let peel = false;
    for (let hi = 0; hi < this.hands.length; hi++) {
      const hand = this.hands[hi];
      if (hand.active && hand.target.y - hand.origin.y > PEEL_LIFT) {
        peel = true;
        break;
      }
    }
    this.peeling = peel;
    const spread = this.press.active;

    let cn = 0;
    let sumDx = 0;
    let sumDz = 0;
    for (let i = 0; i < nodeCount; i++) {
      const i3 = i * 3;
      const onFloorBefore = nodePrev[i3 + 1] <= floorY + FLOOR_CONTACT_EPS;
      const dx = nodePos[i3] - nodePrev[i3];
      const dz = nodePos[i3 + 2] - nodePrev[i3 + 2];
      // Kinetic friction is high during the slow relaxation that follows a
      // gesture (the base holds, so the body springs back to its settled shape)
      // and low during a fast impact (a dropped body slides out and splats).
      // While a tool is active the tack holds the base regardless.
      const slipSpeed = Math.hypot(dx, dz) / h;
      const mu = toolActive
        ? this.params.floorFriction
        : slipSpeed > fastSlip
          ? this.params.freeFriction
          : this.params.floorFriction;
      if (onFloorBefore) {
        const penetration = Math.max(0, floorY - nodePos[i3 + 1]);
        if (peel) {
          nodePos[i3] = nodePrev[i3] + dx * (1 - mu);
          nodePos[i3 + 2] = nodePrev[i3 + 2] + dz * (1 - mu);
        } else {
          // A resting node is held on the floor in y; the tangential motion is
          // what Coulomb friction acts on.
          nodePos[i3 + 1] = floorY;
          const stick = muStatic * penetration + tack;
          if (spread) {
            nodePos[i3] = nodePrev[i3] + dx * (1 - SPREAD_FRICTION);
            nodePos[i3 + 2] = nodePrev[i3 + 2] + dz * (1 - SPREAD_FRICTION);
          } else if (dx * dx + dz * dz <= stick * stick) {
            nodePos[i3] = nodePrev[i3];
            nodePos[i3 + 2] = nodePrev[i3 + 2];
          } else {
            nodePos[i3] = nodePrev[i3] + dx * (1 - mu);
            nodePos[i3 + 2] = nodePrev[i3 + 2] + dz * (1 - mu);
          }
        }
        contactIdx[cn] = i;
        cn += 1;
        sumDx += nodePos[i3] - nodePrev[i3];
        sumDz += nodePos[i3 + 2] - nodePrev[i3 + 2];
      }
      if (nodePos[i3 + 1] < floorY) {
        nodePos[i3 + 1] = floorY;
        if (!onFloorBefore) {
          nodePos[i3] = nodePrev[i3] + (nodePos[i3] - nodePrev[i3]) * (1 - mu);
          nodePos[i3 + 2] = nodePrev[i3 + 2] + (nodePos[i3 + 2] - nodePrev[i3 + 2]) * (1 - mu);
        }
      }
      if (nodePos[i3 + 1] > top) nodePos[i3 + 1] = top;
      const rr = Math.hypot(nodePos[i3], nodePos[i3 + 2]);
      if (rr > boundsRadius) {
        const scale = boundsRadius / rr;
        nodePos[i3] *= scale;
        nodePos[i3 + 2] *= scale;
      }
    }

    // While a tool is active, hold the whole contact patch so a finger pull
    // stretches the body against a stuck base instead of dragging it across the
    // floor. (The no-tool case is held by the force-based Coulomb limit in
    // `applyFloorStaticFriction`, which runs at the end of the substep.)
    if (cn > 0 && toolActive && !spread && !peel) {
      const mdx = sumDx / cn;
      const mdz = sumDz / cn;
      for (let k = 0; k < cn; k++) {
        const i3 = contactIdx[k] * 3;
        nodePos[i3] -= mdx;
        nodePos[i3 + 2] -= mdz;
      }
    }
  }

  /**
   * Patch-level Coulomb static friction (v7). The floor holds the whole contact
   * patch while the net tangential force the body asks it to carry is below the
   * static limit `0.7 · tack · bodyWeight`; above that limit the patch slides
   * (the per-node kinetic friction in `solveFloorAndBounds` bleeds it). The
   * threshold is a force, not a per-substep displacement allowance, so it does
   * not depend on the timestep. It runs at the end of the substep, after every
   * volume and shape pass, so a later correction cannot reintroduce the rigid
   * in-plane drift the old unconditional re-centering used to mask.
   *
   * A palm press spreads the base and a strong upward grab peels it, so both
   * bypass the hold.
   */
  applyFloorStaticFriction(h) {
    const { nodePos, nodePrev, nodeCount, floorY, invMass } = this;
    // A palm press spreads the base and a tool gesture holds it (the grab path
    // in `solveFloorAndBounds`); only the idle / force-push case is handled here.
    if (this.press.active || this.grabbed) return;
    // Net tangential momentum the body gained this substep, over ALL nodes:
    // P = Σ m_i · Δx_i. |P|/h² is the net tangential force the floor must
    // supply to keep the body put. Node mass is 1/invMass.
    let px = 0;
    let pz = 0;
    for (let i = 0; i < nodeCount; i++) {
      const i3 = i * 3;
      const m = 1 / invMass[i];
      px += m * (nodePos[i3] - nodePrev[i3]);
      pz += m * (nodePos[i3 + 2] - nodePrev[i3 + 2]);
    }
    const weight = this.totalRestVolume * this.params.gravity;
    const h2 = h * h;
    if (Math.hypot(px, pz) / h2 > 0.7 * this.params.tackBreak * weight) return;
    // Hold: cancel that momentum with a uniform tangential impulse over the
    // contact patch (the only nodes the floor can act on).
    let contactMass = 0;
    for (let i = 0; i < nodeCount; i++) {
      if (nodePos[i * 3 + 1] > floorY + FLOOR_CONTACT_EPS) continue;
      contactMass += 1 / invMass[i];
    }
    if (contactMass === 0) return;
    const cx = -px / contactMass;
    const cz = -pz / contactMass;
    for (let i = 0; i < nodeCount; i++) {
      const i3 = i * 3;
      if (nodePos[i3 + 1] > floorY + FLOOR_CONTACT_EPS) continue;
      nodePos[i3] += cx;
      nodePos[i3 + 2] += cz;
    }
  }

  applyViscosity(c) {
    const { nodeVel, edges } = this;
    const half = c * 0.5;
    for (let e = 0; e < edges.length; e += 2) {
      const i = edges[e] * 3;
      const j = edges[e + 1] * 3;
      const dvx = nodeVel[j] - nodeVel[i];
      const dvy = nodeVel[j + 1] - nodeVel[i + 1];
      const dvz = nodeVel[j + 2] - nodeVel[i + 2];
      nodeVel[i] += dvx * half;
      nodeVel[i + 1] += dvy * half;
      nodeVel[i + 2] += dvz * half;
      nodeVel[j] -= dvx * half;
      nodeVel[j + 1] -= dvy * half;
      nodeVel[j + 2] -= dvz * half;
    }
  }

  /** Plastic edge flow: the rest length creeps toward the current length. */
  applyPlasticity(h) {
    const { nodePos, edgeRest, edgeRest0, edges, weldA, weldB, weldRest, weldRest0, weldCount } = this;
    const a = 1 - Math.exp(-this.params.plasticRate * h);
    const yieldDist = this.params.plasticYield;
    // Edges of currently inverted tets are skipped (round 11): following the
    // collapsed geometry would bake the inversion into the rest length, locking
    // the crushed state in. The rest length stays until the tet is restored.
    const { tets, tetCount, nodeInverted } = this;
    nodeInverted.fill(0);
    for (let t = 0; t < tetCount; t++) {
      const b = t * 4;
      const n0 = tets[b];
      const n1 = tets[b + 1];
      const n2 = tets[b + 2];
      const n3 = tets[b + 3];
      const i0 = n0 * 3;
      const i1 = n1 * 3;
      const i2 = n2 * 3;
      const i3 = n3 * 3;
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
      const volume = e1x * (e2y * e3z - e2z * e3y) + e1y * (e2z * e3x - e2x * e3z) + e1z * (e2x * e3y - e2y * e3x);
      if (volume <= 0) {
        nodeInverted[n0] = 1;
        nodeInverted[n1] = 1;
        nodeInverted[n2] = 1;
        nodeInverted[n3] = 1;
      }
    }
    for (let k = 0; k < edgeRest.length; k++) {
      const a0 = edges[2 * k];
      const b0 = edges[2 * k + 1];
      if (nodeInverted[a0] || nodeInverted[b0]) continue;
      const i = a0 * 3;
      const j = b0 * 3;
      const length = Math.hypot(nodePos[j] - nodePos[i], nodePos[j + 1] - nodePos[i + 1], nodePos[j + 2] - nodePos[i + 2]);
      if (Math.abs(length - edgeRest[k]) > yieldDist * edgeRest0[k]) {
        edgeRest[k] += (length - edgeRest[k]) * a;
        edgeRest[k] = clamp(edgeRest[k], 0.6 * edgeRest0[k], 2.2 * edgeRest0[k]);
      }
    }
    for (let w = 0; w < weldCount; w++) {
      const i = weldA[w] * 3;
      const j = weldB[w] * 3;
      const length = Math.hypot(nodePos[j] - nodePos[i], nodePos[j + 1] - nodePos[i + 1], nodePos[j + 2] - nodePos[i + 2]);
      if (Math.abs(length - weldRest[w]) > yieldDist * weldRest0[w]) {
        weldRest[w] += (length - weldRest[w]) * a;
        weldRest[w] = clamp(weldRest[w], 0.6 * weldRest0[w], 2.2 * weldRest0[w]);
      }
    }
  }

  /** Skin the render surface from the tet nodes (barycentric interpolation). */
  skin() {
    const { pos, nodePos, embedTet, embedBary, tets, count } = this;
    for (let v = 0; v < count; v++) {
      const tetIndex = embedTet[v];
      const b = tetIndex * 4;
      const b0 = embedBary[v * 4];
      const b1 = embedBary[v * 4 + 1];
      const b2 = embedBary[v * 4 + 2];
      const b3 = embedBary[v * 4 + 3];
      const n0 = tets[b] * 3;
      const n1 = tets[b + 1] * 3;
      const n2 = tets[b + 2] * 3;
      const n3 = tets[b + 3] * 3;
      const v3 = v * 3;
      pos[v3] = b0 * nodePos[n0] + b1 * nodePos[n1] + b2 * nodePos[n2] + b3 * nodePos[n3];
      pos[v3 + 1] = b0 * nodePos[n0 + 1] + b1 * nodePos[n1 + 1] + b2 * nodePos[n2 + 1] + b3 * nodePos[n3 + 1];
      pos[v3 + 2] = b0 * nodePos[n0 + 2] + b1 * nodePos[n1 + 2] + b2 * nodePos[n2 + 2] + b3 * nodePos[n3 + 2];
    }
  }

  /**
   * Displacement-field smoothing of the skinned surface (round 5). Skinning a
   * coarse tet grid shows the tet faces as faint concentric ripples, so the
   * per-vertex displacement from rest is umbrella-smoothed (Jacobi). Rigid
   * motions produce a linear displacement field, which the umbrella operator
   * leaves unchanged, so translation, rotation and lift are preserved. This is
   * an honest visual smoothing of a coarse simulation, not a physics change.
   */
  smoothSurface() {
    const { pos, rest, count, nbrStart, nbrs, floorY } = this;
    const iterations = this.params.skinSmoothIterations;
    if (iterations <= 0) return;
    const lambda = 0.5;
    let src = this.disp;
    let dst = this.dispTmp;
    for (let i = 0; i < pos.length; i++) src[i] = pos[i] - rest[i];
    for (let it = 0; it < iterations; it++) {
      for (let i = 0; i < count; i++) {
        const i3 = i * 3;
        const start = nbrStart[i];
        const end = nbrStart[i + 1];
        const m = end - start;
        if (m === 0) {
          dst[i3] = src[i3];
          dst[i3 + 1] = src[i3 + 1];
          dst[i3 + 2] = src[i3 + 2];
          continue;
        }
        let sx = 0;
        let sy = 0;
        let sz = 0;
        for (let k = start; k < end; k++) {
          const nb = nbrs[k] * 3;
          sx += src[nb];
          sy += src[nb + 1];
          sz += src[nb + 2];
        }
        dst[i3] = src[i3] + lambda * (sx / m - src[i3]);
        dst[i3 + 1] = src[i3 + 1] + lambda * (sy / m - src[i3 + 1]);
        dst[i3 + 2] = src[i3 + 2] + lambda * (sz / m - src[i3 + 2]);
      }
      const swap = src;
      src = dst;
      dst = swap;
    }
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const x = rest[i3] + src[i3];
      const y = rest[i3 + 1] + src[i3 + 1];
      const z = rest[i3 + 2] + src[i3 + 2];
      pos[i3] = x;
      pos[i3 + 1] = y < floorY ? floorY : y;
      pos[i3 + 2] = z;
    }
  }

  /**
   * CSR incidence of surface triangles per vertex, plus the rest one-ring area
   * of every vertex, used by the `surfaceStretch` render attribute.
   */
  buildStretchTopology() {
    const { tris } = this.topo;
    const triCount = tris.length / 3;
    this.surfaceTriCount = triCount;
    this.triStart = new Int32Array(this.count + 1);
    for (let t = 0; t < tris.length; t++) this.triStart[tris[t] + 1] += 1;
    for (let i = 0; i < this.count; i++) this.triStart[i + 1] += this.triStart[i];
    this.triList = new Int32Array(tris.length);
    const cursor = this.triStart.slice(0, this.count);
    for (let tri = 0; tri < triCount; tri++) {
      for (let c = 0; c < 3; c++) {
        const v = tris[tri * 3 + c];
        this.triList[cursor[v]++] = tri;
      }
    }

    this.surfaceStretch = new Float32Array(this.count).fill(1);
    this.stretchTmp = new Float32Array(this.count);
    this.vertexArea = new Float32Array(this.count);
    this.restVertexArea = new Float32Array(this.count);
    this.accumVertexAreas(this.rest, this.restVertexArea);
    this.stretchVersion = 0;
  }

  /** Sum the incident triangle areas of every surface vertex into `out`. */
  accumVertexAreas(pos, out) {
    const { tris } = this.topo;
    const triCount = tris.length / 3;
    out.fill(0);
    for (let tri = 0; tri < triCount; tri++) {
      const a = tris[tri * 3] * 3;
      const b = tris[tri * 3 + 1] * 3;
      const c = tris[tri * 3 + 2] * 3;
      const abx = pos[b] - pos[a];
      const aby = pos[b + 1] - pos[a + 1];
      const abz = pos[b + 2] - pos[a + 2];
      const acx = pos[c] - pos[a];
      const acy = pos[c + 1] - pos[a + 1];
      const acz = pos[c + 2] - pos[a + 2];
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      const area = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
      out[a / 3] += area;
      out[b / 3] += area;
      out[c / 3] += area;
    }
  }

  /**
   * Recompute `surfaceStretch` (current one-ring triangle area over the rest
   * one-ring area), followed by one Jacobi smoothing pass over the surface
   * neighbours so a stretched patch reads as a smooth field. Called only while
   * the body is moving; `stretchVersion` tells the renderer when to re-upload.
   *
   * The reference one-ring areas track the settled surface: while no gesture is
   * active they follow the current surface, so a body simply sitting under
   * gravity reads as unstretched (stretch ~= 1) and only a real deformation —
   * which freezes the reference for the duration of the gesture — moves it.
   */
  updateStretch() {
    const { pos, restVertexArea, surfaceStretch, vertexArea, stretchTmp, nbrStart, nbrs, count } = this;
    this.accumVertexAreas(pos, vertexArea);
    if (!this.grabbed && !this.press.active) {
      restVertexArea.set(vertexArea);
    }
    for (let i = 0; i < count; i++) {
      surfaceStretch[i] = vertexArea[i] / restVertexArea[i];
    }
    for (let i = 0; i < count; i++) {
      const start = nbrStart[i];
      const end = nbrStart[i + 1];
      const m = end - start;
      if (m === 0) {
        stretchTmp[i] = surfaceStretch[i];
        continue;
      }
      let sum = 0;
      for (let k = start; k < end; k++) sum += surfaceStretch[nbrs[k]];
      stretchTmp[i] = 0.5 * (surfaceStretch[i] + sum / m);
    }
    surfaceStretch.set(stretchTmp);
    this.stretchVersion += 1;
  }

  /** Call once per frame, after the substeps. `dt` is the frame duration (s). */
  updateDerived(dt) {
    this.skin();
    this.smoothSurface();

    const { pos, count, nodeVel, nodeCount, nodePos } = this;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const x = pos[i3];
      const y = pos[i3 + 1];
      const z = pos[i3 + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new Error('SoftBody diverged: non-finite vertex position');
      }
      cx += x;
      cy += y;
      cz += z;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    cx /= count;
    cy /= count;
    cz /= count;

    let radiusSq = 0;
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const dx = pos[i3] - cx;
      const dy = pos[i3 + 1] - cy;
      const dz = pos[i3 + 2] - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > radiusSq) radiusSq = d2;
    }

    this.centroid = { x: cx, y: cy, z: cz };
    this.bounds = { minX, minY, minZ, maxX, maxY, maxZ, cx, cy, cz, radius: Math.sqrt(radiusSq) };

    const threshold = this.floorY + 0.01;
    let contactCount = 0;
    let sumX = 0;
    let sumZ = 0;
    let contactMinY = Infinity;
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      if (pos[i3 + 1] <= threshold) {
        contactCount += 1;
        sumX += pos[i3];
        sumZ += pos[i3 + 2];
        if (pos[i3 + 1] < contactMinY) contactMinY = pos[i3 + 1];
      }
    }
    if (contactCount === 0) {
      this.contact = { x: cx, z: cz, radius: 0, count: 0, minY: minY };
    } else {
      const mx = sumX / contactCount;
      const mz = sumZ / contactCount;
      let contactRadiusSq = 0;
      for (let i = 0; i < count; i++) {
        const i3 = i * 3;
        if (pos[i3 + 1] <= threshold) {
          const dx = pos[i3] - mx;
          const dz = pos[i3 + 2] - mz;
          const d2 = dx * dx + dz * dz;
          if (d2 > contactRadiusSq) contactRadiusSq = d2;
        }
      }
      this.contact = {
        x: mx,
        z: mz,
        radius: Math.sqrt(contactRadiusSq),
        count: contactCount,
        minY: contactMinY,
      };
    }

    let energySq = 0;
    for (let i = 0; i < nodeCount; i++) {
      const i3 = i * 3;
      const s = nodeVel[i3] * nodeVel[i3] + nodeVel[i3 + 1] * nodeVel[i3 + 1] + nodeVel[i3 + 2] * nodeVel[i3 + 2];
      if (s > energySq) energySq = s;
    }
    this.energy = Math.sqrt(energySq);

    let maxStrain = 0;
    for (let k = 0; k < this.edgeRest0.length; k++) {
      const i = this.edges[2 * k] * 3;
      const j = this.edges[2 * k + 1] * 3;
      const length = Math.hypot(
        this.nodePos[j] - this.nodePos[i],
        this.nodePos[j + 1] - this.nodePos[i + 1],
        this.nodePos[j + 2] - this.nodePos[i + 2]
      );
      const strain = Math.abs(length / this.edgeRest0[k] - 1);
      if (strain > maxStrain) maxStrain = strain;
    }
    this.maxDisp = maxStrain;

    // Node bounds of the simulation volume (the implicit-surface renderer boxes
    // the field around these).
    let nMinX = Infinity;
    let nMinY = Infinity;
    let nMinZ = Infinity;
    let nMaxX = -Infinity;
    let nMaxY = -Infinity;
    let nMaxZ = -Infinity;
    for (let i = 0; i < nodeCount; i++) {
      const i3 = i * 3;
      const x = nodePos[i3];
      const y = nodePos[i3 + 1];
      const z = nodePos[i3 + 2];
      if (x < nMinX) nMinX = x;
      if (x > nMaxX) nMaxX = x;
      if (y < nMinY) nMinY = y;
      if (y > nMaxY) nMaxY = y;
      if (z < nMinZ) nMinZ = z;
      if (z > nMaxZ) nMaxZ = z;
    }
    this.nodeBounds = { minX: nMinX, minY: nMinY, minZ: nMinZ, maxX: nMaxX, maxY: nMaxY, maxZ: nMaxZ };

    // Feedback signals (v7). `deformRate` is the RMS deviation of the node
    // velocities from their mean at the last substep; `impact` the downward
    // centroid speed just before a floor contact that began during this frame;
    // `weldBreaks` the welds snapped since the last update; `depthRate` the sum
    // over active hands of d(depth)/dt, positive while the fingers sink.
    let meanVx = 0;
    let meanVy = 0;
    let meanVz = 0;
    for (let i = 0; i < nodeCount; i++) {
      const i3 = i * 3;
      meanVx += nodeVel[i3];
      meanVy += nodeVel[i3 + 1];
      meanVz += nodeVel[i3 + 2];
    }
    meanVx /= nodeCount;
    meanVy /= nodeCount;
    meanVz /= nodeCount;
    let deformSq = 0;
    for (let i = 0; i < nodeCount; i++) {
      const i3 = i * 3;
      const dx = nodeVel[i3] - meanVx;
      const dy = nodeVel[i3 + 1] - meanVy;
      const dz = nodeVel[i3 + 2] - meanVz;
      deformSq += dx * dx + dy * dy + dz * dz;
    }
    this.signals.deformRate = Math.sqrt(deformSq / nodeCount);
    this.signals.impact = this.impactPending;
    this.signals.weldBreaks = this.weldBreaksSinceUpdate;
    this.signals.depthRate = this.stepsSinceUpdate > 0 ? this.depthRateSum / this.stepsSinceUpdate : 0;
    this.impactPending = 0;
    this.weldBreaksSinceUpdate = 0;
    this.depthRateSum = 0;
    this.stepsSinceUpdate = 0;

    // Temporary welds age only while the body is left alone; then the render
    // surface colours are mixed from the kneading motion and interpolated from
    // the node colours through the embedding.
    if (!this.grabbed && !this.press.active) this.ageWelds(dt);
    this.mixColors(dt);
    if (this.colorsDirty) this.skinColors();

    // Capture the settled shape once the body has rested after a reset; the
    // shape-matching goal is that settled frame, not the undeformed rest shape.
    if (!this.grabbed && !this.press.active && this.energy < 1e-3) {
      this.idleTime += dt;
    } else {
      this.idleTime = 0;
    }
    if (!this.shapeGoalReady && this.idleTime > 0.3) {
      this.captureShapeGoal();
      this.shapeGoalReady = true;
    }

    const moved = this.energy > 1e-3 || this.grabbed || this.press.active;
    if (moved) this.updateStretch();
    this.normalsDirty = moved;
  }

  /** Barycentric interpolation of nodeColor through the embedding. */
  skinColors() {
    const { surfaceColor, nodeColor, embedTet, embedBary, tets, count } = this;
    for (let v = 0; v < count; v++) {
      const b = embedTet[v] * 4;
      const b0 = embedBary[v * 4];
      const b1 = embedBary[v * 4 + 1];
      const b2 = embedBary[v * 4 + 2];
      const b3 = embedBary[v * 4 + 3];
      const n0 = tets[b] * 3;
      const n1 = tets[b + 1] * 3;
      const n2 = tets[b + 2] * 3;
      const n3 = tets[b + 3] * 3;
      const v3 = v * 3;
      surfaceColor[v3] = b0 * nodeColor[n0] + b1 * nodeColor[n1] + b2 * nodeColor[n2] + b3 * nodeColor[n3];
      surfaceColor[v3 + 1] = b0 * nodeColor[n0 + 1] + b1 * nodeColor[n1 + 1] + b2 * nodeColor[n2 + 1] + b3 * nodeColor[n3 + 1];
      surfaceColor[v3 + 2] = b0 * nodeColor[n0 + 2] + b1 * nodeColor[n1 + 2] + b2 * nodeColor[n2 + 2] + b3 * nodeColor[n3 + 2];
    }
    this.colorsDirty = false;
    this.colorVersion += 1;
  }

  /**
   * Kneading colour mixing (round 7). Colours ride on the material, so
   * stretching and folding streak them (advection), and only where the material
   * is actually moving do colours blend — there is no isotropic per-edge blur.
   *   edges: `a = max(0, activity − mixActivityFloor)`, `k = min(0.05, edgeMix·a·dt)`
   *   welds: `k = min(0.2, weldMix·activity·dt)`
   * `activity` is the strain rate `|L − Lprev| / rest / dt`. At rest the
   * activity floor suppresses all mixing, so nothing is recomputed and
   * `colorVersion` does not move. `dt` is the frame duration; without a time
   * step there is nothing to integrate (the lengths are still tracked).
   */
  mixColors(dt) {
    const { nodeColor, nodePos, edges, edgeRest, edgeLprev, weldA, weldB, weldRest, weldLprev, weldCount } = this;
    const edgeMix = this.params.edgeMix;
    const weldMix = this.params.weldMix;
    const floor = CONFIG.knead.mixActivityFloor;
    const hasDt = dt > 0;
    let dirty = false;
    for (let k = 0; k < edgeRest.length; k++) {
      const a = edges[2 * k];
      const b = edges[2 * k + 1];
      const i = a * 3;
      const j = b * 3;
      const length = Math.hypot(nodePos[j] - nodePos[i], nodePos[j + 1] - nodePos[i + 1], nodePos[j + 2] - nodePos[i + 2]);
      const prev = edgeLprev[k];
      edgeLprev[k] = length;
      if (!hasDt) continue;
      const activity = Math.abs(length - prev) / edgeRest[k] / dt - floor;
      if (activity <= 0) continue;
      const mix = Math.min(0.05, edgeMix * activity * dt);
      if (mix <= 1e-4) continue;
      dirty = true;
      mixPair(nodeColor, a, b, mix);
    }
    for (let w = 0; w < weldCount; w++) {
      const i = weldA[w];
      const j = weldB[w];
      const i3 = i * 3;
      const j3 = j * 3;
      const length = Math.hypot(nodePos[j3] - nodePos[i3], nodePos[j3 + 1] - nodePos[i3 + 1], nodePos[j3 + 2] - nodePos[i3 + 2]);
      const prev = weldLprev[w];
      weldLprev[w] = length;
      if (!hasDt) continue;
      const activity = Math.abs(length - prev) / weldRest[w] / dt;
      const mix = Math.min(0.2, weldMix * activity * dt);
      if (mix <= 1e-4) continue;
      dirty = true;
      mixPair(nodeColor, i, j, mix);
    }
    if (dirty) this.colorsDirty = true;
  }

  /**
   * Select the nodes a hand influences. The gaussian is anchored in REST space:
   * the node whose current position is closest to `point` supplies the rest-space
   * centre, and every node is weighted by its rest offset from that centre. A
   * fixed topological neighbourhood cannot feed back on itself, which is what let
   * a side pull crumple the pulled end. Offsets are current position − point.
   */
  selectHand(hand, point, radius) {
    const { nodePos, nodeRest, nodeCount } = this;
    const falloff = CONFIG.grab.pull.falloff;
    const invR2 = 1 / (radius * radius);

    let seed = 0;
    let bestSq = Infinity;
    for (let i = 0; i < nodeCount; i++) {
      const i3 = i * 3;
      const dx = nodePos[i3] - point.x;
      const dy = nodePos[i3 + 1] - point.y;
      const dz = nodePos[i3 + 2] - point.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestSq) {
        bestSq = d2;
        seed = i;
      }
    }
    const cx = nodeRest[seed * 3];
    const cy = nodeRest[seed * 3 + 1];
    const cz = nodeRest[seed * 3 + 2];

    let n = 0;
    for (let i = 0; i < nodeCount; i++) {
      const i3 = i * 3;
      const rx = nodeRest[i3] - cx;
      const ry = nodeRest[i3 + 1] - cy;
      const rz = nodeRest[i3 + 2] - cz;
      const w = Math.exp(-falloff * (rx * rx + ry * ry + rz * rz) * invR2);
      if (w < 0.03) continue;
      hand.idx[n] = i;
      hand.w[n] = w;
      hand.off[n * 3] = nodePos[i3] - point.x;
      hand.off[n * 3 + 1] = nodePos[i3 + 1] - point.y;
      hand.off[n * 3 + 2] = nodePos[i3 + 2] - point.z;
      n += 1;
    }
    if (n === 0) {
      throw new Error('SoftBody.beginGrab selected no nodes');
    }
    hand.count = n;
    hand.radius = radius;
  }

  /**
   * Start a grab; returns the hand handle. `normal` is the unit outward surface
   * normal at the touch and is required (missing or non-finite throws); the
   * force-driven finger pushes the patch along -normal. Throws if no hand is
   * free.
   */
  beginGrab(point, radius, normal) {
    if (
      !normal ||
      !Number.isFinite(normal.x) ||
      !Number.isFinite(normal.y) ||
      !Number.isFinite(normal.z)
    ) {
      throw new Error('SoftBody.beginGrab requires a finite unit normal {x, y, z}');
    }
    let handle = -1;
    for (let h = 0; h < this.hands.length; h++) {
      if (!this.hands[h].active) {
        handle = h;
        break;
      }
    }
    if (handle < 0) {
      throw new Error(`SoftBody.beginGrab: all ${this.hands.length} hands are active`);
    }
    const hand = this.hands[handle];
    hand.target = { x: point.x, y: point.y, z: point.z };
    hand.origin = { x: point.x, y: point.y, z: point.z };
    hand.normal = { x: normal.x, y: normal.y, z: normal.z };
    hand.push = 0;
    hand.depth = 0;
    hand.center = { x: point.x, y: point.y, z: point.z };
    this.selectHand(hand, point, radius);
    hand.active = true;
    return handle;
  }

  /** Move a hand's target (hit point + drag). Throws on an inactive handle. */
  setGrabTarget(handle, x, y, z) {
    const hand = this.hands[handle];
    if (!hand || !hand.active) {
      throw new Error(`SoftBody.setGrabTarget: hand ${handle} is not active`);
    }
    hand.target.x = x;
    hand.target.y = y;
    hand.target.z = z;
  }

  /**
   * Set the hand's finger force, in units of the body's own weight. The solver
   * turns it into a depth that depends on the material. Throws on an inactive
   * handle or a non-finite / negative force.
   */
  setGrabPush(handle, force) {
    const hand = this.hands[handle];
    if (!hand || !hand.active) {
      throw new Error(`SoftBody.setGrabPush: hand ${handle} is not active`);
    }
    if (!Number.isFinite(force) || force < 0) {
      throw new Error(`SoftBody.setGrabPush requires a finite non-negative force; got ${force}`);
    }
    hand.push = force;
  }

  /** Re-select nodes around the hand's CURRENT target with the gaussian. */
  setGrabRadius(handle, radius) {
    const hand = this.hands[handle];
    if (!hand || !hand.active) {
      throw new Error(`SoftBody.setGrabRadius: hand ${handle} is not active`);
    }
    this.selectHand(hand, hand.target, radius);
  }

  /** Release a hand. Throws on an inactive handle. */
  endGrab(handle) {
    const hand = this.hands[handle];
    if (!hand || !hand.active) {
      throw new Error(`SoftBody.endGrab: hand ${handle} is not active`);
    }
    hand.active = false;
    hand.push = 0;
    hand.count = 0;
  }

  topHeightAt(x, z, radius) {
    const { pos, count } = this;
    const r2 = radius * radius;
    let best = -Infinity;
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const dx = pos[i3] - x;
      const dz = pos[i3 + 2] - z;
      if (dx * dx + dz * dz < r2 && pos[i3 + 1] > best) best = pos[i3 + 1];
    }
    if (best === -Infinity) {
      throw new Error('SoftBody.topHeightAt found no vertices under the palm');
    }
    return best;
  }

  beginPress(x, z, y, radius) {
    this.press = { active: true, x, z, y, radius };
  }

  setPress(x, z, y) {
    this.press.x = x;
    this.press.z = z;
    this.press.y = y;
  }

  endPress() {
    this.press.active = false;
  }

  pokeAt(point, normal, strength) {
    const { nodePos, nodeVel, nodeCount } = this;
    const radius = CONFIG.grab.pull.radius;
    const falloff = CONFIG.grab.pull.falloff;
    const invR2 = 1 / (radius * radius);
    for (let i = 0; i < nodeCount; i++) {
      const i3 = i * 3;
      const dx = nodePos[i3] - point.x;
      const dy = nodePos[i3 + 1] - point.y;
      const dz = nodePos[i3 + 2] - point.z;
      const w = Math.exp(-falloff * (dx * dx + dy * dy + dz * dz) * invR2);
      if (w < 0.03) continue;
      const k = strength * w;
      nodeVel[i3] -= normal.x * k;
      nodeVel[i3 + 1] -= normal.y * k;
      nodeVel[i3 + 2] -= normal.z * k;
    }
  }

  /** Set the whole-body colour (linear RGB) and clear any marbling. */
  setBaseColor(rgb) {
    if (!rgb || !Number.isFinite(rgb[0]) || !Number.isFinite(rgb[1]) || !Number.isFinite(rgb[2])) {
      throw new Error(`SoftBody.setBaseColor requires a finite [r, g, b]; got ${JSON.stringify(rgb)}`);
    }
    const { nodeColor } = this;
    for (let i = 0; i < nodeColor.length; i += 3) {
      nodeColor[i] = rgb[0];
      nodeColor[i + 1] = rgb[1];
      nodeColor[i + 2] = rgb[2];
    }
    this.colorsDirty = true;
  }

  /**
   * Paint a dollop into the nodes within `radius` of `point` (current
   * positions). A full replacement inside `0.5·radius` and a smoothstep falloff
   * to zero at `radius`, so a dropped dollop stays a distinct patch instead of
   * a soft cloud that diffusion can smear. Throws if no node is in range.
   */
  paintColor(point, radius, rgb) {
    if (!Number.isFinite(radius) || radius <= 0) {
      throw new Error(`SoftBody.paintColor requires a positive radius; got ${radius}`);
    }
    if (!rgb || !Number.isFinite(rgb[0]) || !Number.isFinite(rgb[1]) || !Number.isFinite(rgb[2])) {
      throw new Error(`SoftBody.paintColor requires a finite [r, g, b]; got ${JSON.stringify(rgb)}`);
    }
    const { nodePos, nodeColor, nodeCount } = this;
    const half = 0.5 * radius;
    let touched = 0;
    for (let i = 0; i < nodeCount; i++) {
      const i3 = i * 3;
      const dx = nodePos[i3] - point.x;
      const dy = nodePos[i3 + 1] - point.y;
      const dz = nodePos[i3 + 2] - point.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > radius * radius) continue;
      const d = Math.sqrt(d2);
      const k = d <= half ? 1 : 1 - smoothstep(half, radius, d);
      nodeColor[i3] += (rgb[0] - nodeColor[i3]) * k;
      nodeColor[i3 + 1] += (rgb[1] - nodeColor[i3 + 1]) * k;
      nodeColor[i3 + 2] += (rgb[2] - nodeColor[i3 + 2]) * k;
      touched += 1;
    }
    if (touched === 0) {
      throw new Error('SoftBody.paintColor found no nodes within radius');
    }
    this.colorsDirty = true;
  }

  /** Deactivate every hand (used by reset; does not throw). */
  releaseAllHands() {
    for (let h = 0; h < this.hands.length; h++) {
      this.hands[h].active = false;
      this.hands[h].push = 0;
      this.hands[h].count = 0;
    }
  }

  drop(height) {
    const { nodePos, nodePrev, nodeVel } = this;
    for (let i = 1; i < nodePos.length; i += 3) {
      nodePos[i] += height;
      nodePrev[i] += height;
    }
    nodeVel.fill(0);
  }

  reset({ drop } = {}) {
    this.nodePos.set(this.nodeRest);
    this.nodePrev.set(this.nodeRest);
    this.nodeVel.fill(0);
    this.edgeRest.set(this.edgeRest0);
    this.releaseAllHands();
    this.endPress();
    this.weldSet.clear();
    this.weldCount = 0;
    this.substepCount = 0;
    this.shapeGoalReady = false;
    this.idleTime = 0;
    this.impactPending = 0;
    this.weldBreaksSinceUpdate = 0;
    this.depthRateSum = 0;
    this.stepsSinceUpdate = 0;
    this.prevFloorContactCount = 0;
    this.prevCentroidVelY = 0;
    this.accumVertexAreas(this.rest, this.restVertexArea);
    if (drop) this.drop(CONFIG.simulation.dropHeight);
    this.normalsDirty = true;
    this.updateDerived(0);
  }

  /** Number of tetrahedra that have collapsed or inverted (volume <= 0). */
  countFlipped() {
    const { tets, tetCount, nodePos } = this;
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
      const volume = e1x * (e2y * e3z - e2z * e3y) + e1y * (e2z * e3x - e2x * e3z) + e1z * (e2x * e3y - e2y * e3x);
      if (volume <= 0) flipped += 1;
    }
    return flipped;
  }

  /**
   * Surface roughness over the WHOLE mesh (no exclusion): the change in the
   * magnitude of the discrete Laplacian,
   *   dev_i = | |pos_i - mean(nbr)| - |rest_i - mean(rest nbr)| | / meanRestEdge.
   * Returns the 99th percentile and the maximum.
   */
  measureRoughness() {
    const { pos, rest, nbrStart, nbrs, count, meanRestEdge } = this;
    const dev = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const start = nbrStart[i];
      const end = nbrStart[i + 1];
      const m = end - start;
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let rx = 0;
      let ry = 0;
      let rz = 0;
      for (let k = start; k < end; k++) {
        const nb = nbrs[k] * 3;
        sx += pos[nb];
        sy += pos[nb + 1];
        sz += pos[nb + 2];
        rx += rest[nb];
        ry += rest[nb + 1];
        rz += rest[nb + 2];
      }
      const dpx = pos[i3] - sx / m;
      const dpy = pos[i3 + 1] - sy / m;
      const dpz = pos[i3 + 2] - sz / m;
      const drx = rest[i3] - rx / m;
      const dry = rest[i3 + 1] - ry / m;
      const drz = rest[i3 + 2] - rz / m;
      dev[i] = Math.abs(Math.hypot(dpx, dpy, dpz) - Math.hypot(drx, dry, drz)) / meanRestEdge;
    }
    const sorted = dev.slice().sort();
    const p99 = sorted[Math.min(count - 1, Math.floor(0.99 * count))];
    return { roughP99: p99, roughMax: sorted[count - 1] };
  }

  /**
   * Max distance between the current surface and a reference surface after the
   * best-fit rigid transform (Kabsch via polar decomposition of the
   * cross-covariance). Translation and rotation are discounted, so this
   * measures how far the body still is from its reference SHAPE. Used to prove
   * recovery: after a gesture is released and the body relaxes, shapeError
   * against the settled shape must go to zero.
   */
  shapeError(reference) {
    const { pos, count } = this;
    if (!reference || reference.length !== pos.length) {
      throw new Error('SoftBody.shapeError requires a reference array of the same length as pos');
    }

    let pcx = 0;
    let pcy = 0;
    let pcz = 0;
    let rcx = 0;
    let rcy = 0;
    let rcz = 0;
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      pcx += pos[i3];
      pcy += pos[i3 + 1];
      pcz += pos[i3 + 2];
      rcx += reference[i3];
      rcy += reference[i3 + 1];
      rcz += reference[i3 + 2];
    }
    pcx /= count;
    pcy /= count;
    pcz /= count;
    rcx /= count;
    rcy /= count;
    rcz /= count;

    const H = new Float64Array(9);
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const px = pos[i3] - pcx;
      const py = pos[i3 + 1] - pcy;
      const pz = pos[i3 + 2] - pcz;
      const rx = reference[i3] - rcx;
      const ry = reference[i3 + 1] - rcy;
      const rz = reference[i3 + 2] - rcz;
      H[0] += px * rx;
      H[1] += px * ry;
      H[2] += px * rz;
      H[3] += py * rx;
      H[4] += py * ry;
      H[5] += py * rz;
      H[6] += pz * rx;
      H[7] += pz * ry;
      H[8] += pz * rz;
    }
    const R = extractRotation(H, this.shapeQuat, 8);

    let maxErr = 0;
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const px = pos[i3] - pcx;
      const py = pos[i3 + 1] - pcy;
      const pz = pos[i3 + 2] - pcz;
      const rx = reference[i3] - rcx;
      const ry = reference[i3 + 1] - rcy;
      const rz = reference[i3 + 2] - rcz;
      const ex = px - (R[0] * rx + R[1] * ry + R[2] * rz);
      const ey = py - (R[3] * rx + R[4] * ry + R[5] * rz);
      const ez = pz - (R[6] * rx + R[7] * ry + R[8] * rz);
      const d = Math.hypot(ex, ey, ez);
      if (d > maxErr) maxErr = d;
    }
    return maxErr;
  }

  stats() {
    const { tets, tetCount, nodePos } = this;
    let volume = 0;
    let restVolume = 0;
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
      volume += (e1x * (e2y * e3z - e2z * e3y) + e1y * (e2z * e3x - e2x * e3z) + e1z * (e2x * e3y - e2y * e3x)) / 6;
      restVolume += this.tetRest0[t];
    }

    let maxStretch = 0;
    for (let k = 0; k < this.edgeRest0.length; k++) {
      const i = this.edges[2 * k] * 3;
      const j = this.edges[2 * k + 1] * 3;
      const ratio = Math.hypot(
        this.nodePos[j] - this.nodePos[i],
        this.nodePos[j + 1] - this.nodePos[i + 1],
        this.nodePos[j + 2] - this.nodePos[i + 2]
      ) / this.edgeRest0[k];
      if (ratio > maxStretch) maxStretch = ratio;
    }

    return {
      volumeRatio: volume / restVolume,
      maxStretch,
      contactRadius: this.contact.radius,
      centroid: { x: this.centroid.x, y: this.centroid.y, z: this.centroid.z },
      lifted: this.contact.minY > this.floorY + 0.02,
      flipped: this.countFlipped(),
      nodeCount: this.nodeCount,
      tetCount: this.tetCount,
      welds: this.weldCount,
      collisions: this.collisions,
      ...this.measureRoughness(),
    };
  }
}
