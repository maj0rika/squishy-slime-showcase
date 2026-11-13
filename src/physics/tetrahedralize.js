/**
 * Volumetric tetrahedralization of a closed triangle surface (Müller,
 * "Ten Minute Physics" soft bodies).
 *
 * Pure JavaScript on purpose: no three.js import, so the solver and its tests
 * run in Node. A real squishy is a solid, so the simulation volume is filled
 * with a uniform grid of nodes and 6 Kuhn tetrahedra per kept cell, and every
 * render vertex is embedded in one of those tets with barycentric weights.
 *
 * Nothing here degrades silently: a malformed surface, a non-positive tet
 * volume or a vertex that fails to embed all throw.
 */

const AXES = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

// The six Kuhn tetrahedra of a cube, one per axis permutation.
const PERMUTATIONS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

/**
 * @param {{ surfacePos: Float32Array, index: Uint32Array, spacing: number }} args
 * @returns {{
 *   nodes: Float32Array, tets: Int32Array, edges: Int32Array, restVol: Float32Array,
 *   invMass: Float32Array, embedTet: Int32Array, embedBary: Float32Array,
 *   nodeCount: number, tetCount: number, edgeCount: number,
 * }}
 */
export function tetrahedralize({ surfacePos, index, spacing }) {
  if (!surfacePos || surfacePos.length === 0 || surfacePos.length % 3 !== 0) {
    throw new Error('tetrahedralize requires a non-empty surface position array');
  }
  if (!index || index.length === 0 || index.length % 3 !== 0) {
    throw new Error('tetrahedralize requires a triangle index array');
  }
  if (!Number.isFinite(spacing) || spacing <= 0) {
    throw new Error(`tetrahedralize requires a positive spacing; got ${spacing}`);
  }

  const s = spacing;
  const surfaceCount = surfacePos.length / 3;
  const triCount = index.length / 3;

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < surfacePos.length; i += 3) {
    const x = surfacePos[i];
    const y = surfacePos[i + 1];
    const z = surfacePos[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  const x0 = minX - 0.5 * s;
  const y0 = minY;
  const z0 = minZ - 0.5 * s;
  const nx = Math.ceil((maxX - x0) / s) + 1;
  const ny = Math.ceil((maxY - y0) / s) + 1;
  const nz = Math.ceil((maxZ - z0) / s) + 1;
  const cellX = nx - 1;
  const cellY = ny - 1;
  const cellZ = nz - 1;

  // --- Ray-parity "inside" test, accelerated by (y, z) buckets ---------------
  // The parity ray points almost exactly along +x, so its y/z coordinates are
  // effectively constant along the ray. Bucketing the triangles by their (y, z)
  // span (grown by a small tolerance) lets a query touch only the handful of
  // triangles near the ray line instead of the whole surface.
  let rdx = 1;
  let rdy = 1e-4;
  let rdz = 2e-4;
  const rInv = 1 / Math.hypot(rdx, rdy, rdz);
  rdx *= rInv;
  rdy *= rInv;
  rdz *= rInv;

  const tv = new Float32Array(triCount * 9);
  const triMinY = new Float32Array(triCount);
  const triMaxY = new Float32Array(triCount);
  const triMinZ = new Float32Array(triCount);
  const triMaxZ = new Float32Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const a = index[t * 3] * 3;
    const b = index[t * 3 + 1] * 3;
    const c = index[t * 3 + 2] * 3;
    const o = t * 9;
    tv[o] = surfacePos[a];
    tv[o + 1] = surfacePos[a + 1];
    tv[o + 2] = surfacePos[a + 2];
    tv[o + 3] = surfacePos[b];
    tv[o + 4] = surfacePos[b + 1];
    tv[o + 5] = surfacePos[b + 2];
    tv[o + 6] = surfacePos[c];
    tv[o + 7] = surfacePos[c + 1];
    tv[o + 8] = surfacePos[c + 2];
    const ay = tv[o + 1];
    const by = tv[o + 4];
    const cy = tv[o + 7];
    const az = tv[o + 2];
    const bz = tv[o + 5];
    const cz = tv[o + 8];
    triMinY[t] = Math.min(ay, by, cy);
    triMaxY[t] = Math.max(ay, by, cy);
    triMinZ[t] = Math.min(az, bz, cz);
    triMaxZ[t] = Math.max(az, bz, cz);
  }

  const tol = 2e-3;
  const bandCount = ny * nz;
  const bandStart = new Int32Array(bandCount + 1);
  const iyLo = new Int32Array(triCount);
  const iyHi = new Int32Array(triCount);
  const izLo = new Int32Array(triCount);
  const izHi = new Int32Array(triCount);
  const bandY = (v) => {
    let b = Math.floor((v - y0) / s);
    if (b < 0) b = 0;
    else if (b > ny - 1) b = ny - 1;
    return b;
  };
  const bandZ = (v) => {
    let b = Math.floor((v - z0) / s);
    if (b < 0) b = 0;
    else if (b > nz - 1) b = nz - 1;
    return b;
  };
  for (let t = 0; t < triCount; t++) {
    const lo = bandY(triMinY[t] - tol);
    const hi = bandY(triMaxY[t] + tol);
    const loZ = bandZ(triMinZ[t] - tol);
    const hiZ = bandZ(triMaxZ[t] + tol);
    iyLo[t] = lo;
    iyHi[t] = hi;
    izLo[t] = loZ;
    izHi[t] = hiZ;
    for (let iy = lo; iy <= hi; iy++) {
      for (let iz = loZ; iz <= hiZ; iz++) bandStart[iy * nz + iz + 1] += 1;
    }
  }
  for (let i = 0; i < bandCount; i++) bandStart[i + 1] += bandStart[i];
  const bandCursor = bandStart.slice(0, bandCount);
  const bandTri = new Int32Array(bandStart[bandCount]);
  for (let t = 0; t < triCount; t++) {
    for (let iy = iyLo[t]; iy <= iyHi[t]; iy++) {
      for (let iz = izLo[t]; iz <= izHi[t]; iz++) {
        bandTri[bandCursor[iy * nz + iz]++] = t;
      }
    }
  }

  const inside = (px, py, pz) => {
    const iy = bandY(py);
    const iz = bandZ(pz);
    const start = bandStart[iy * nz + iz];
    const end = bandStart[iy * nz + iz + 1];
    let hits = 0;
    for (let bi = start; bi < end; bi++) {
      const t = bandTri[bi];
      const o = t * 9;
      const ax = tv[o];
      const ay = tv[o + 1];
      const az = tv[o + 2];
      const e1x = tv[o + 3] - ax;
      const e1y = tv[o + 4] - ay;
      const e1z = tv[o + 5] - az;
      const e2x = tv[o + 6] - ax;
      const e2y = tv[o + 7] - ay;
      const e2z = tv[o + 8] - az;
      const pvx = rdy * e2z - rdz * e2y;
      const pvy = rdz * e2x - rdx * e2z;
      const pvz = rdx * e2y - rdy * e2x;
      const det = e1x * pvx + e1y * pvy + e1z * pvz;
      if (det > -1e-12 && det < 1e-12) continue;
      const invDet = 1 / det;
      const tx = px - ax;
      const ty = py - ay;
      const tz = pz - az;
      const u = (tx * pvx + ty * pvy + tz * pvz) * invDet;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y;
      const qy = tz * e1x - tx * e1z;
      const qz = tx * e1y - ty * e1x;
      const v = (rdx * qx + rdy * qy + rdz * qz) * invDet;
      if (v < 0 || u + v > 1) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * invDet;
      if (tt > 1e-9) hits += 1;
    }
    return (hits & 1) === 1;
  };

  // --- Kept cells -----------------------------------------------------------
  const cornerIndex = (gi, gj, gk) => (gi * ny + gj) * nz + gk;
  const cornerInside = new Uint8Array(nx * ny * nz);
  const isCornerInside = (gi, gj, gk) => {
    const idx = cornerIndex(gi, gj, gk);
    const state = cornerInside[idx];
    if (state !== 0) return state === 2;
    const result = inside(x0 + gi * s, y0 + gj * s, z0 + gk * s);
    cornerInside[idx] = result ? 2 : 1;
    return result;
  };

  const cellIndex = (i, j, k) => (i * cellY + j) * cellZ + k;
  const cellCount = cellX * cellY * cellZ;
  const kept = new Uint8Array(cellCount);
  const clampCell = (value, count) => {
    let c = Math.floor(value);
    if (c < 0) c = 0;
    else if (c > count - 1) c = count - 1;
    return c;
  };
  for (let v = 0; v < surfacePos.length; v += 3) {
    const i = clampCell((surfacePos[v] - x0) / s, cellX);
    const j = clampCell((surfacePos[v + 1] - y0) / s, cellY);
    const k = clampCell((surfacePos[v + 2] - z0) / s, cellZ);
    kept[cellIndex(i, j, k)] = 1;
  }
  for (let i = 0; i < cellX; i++) {
    for (let j = 0; j < cellY; j++) {
      for (let k = 0; k < cellZ; k++) {
        if (kept[cellIndex(i, j, k)]) continue;
        let anyInside = false;
        for (let b = 0; b < 8 && !anyInside; b++) {
          if (isCornerInside(i + (b & 1), j + ((b >> 1) & 1), k + ((b >> 2) & 1))) {
            anyInside = true;
          }
        }
        if (anyInside) kept[cellIndex(i, j, k)] = 1;
      }
    }
  }

  // --- Nodes and Kuhn tetrahedra -------------------------------------------
  const nodeMap = new Int32Array(nx * ny * nz).fill(-1);
  const nodeArr = [];
  const getNode = (gi, gj, gk) => {
    const idx = cornerIndex(gi, gj, gk);
    let n = nodeMap[idx];
    if (n === -1) {
      n = nodeArr.length / 3;
      nodeMap[idx] = n;
      nodeArr.push(x0 + gi * s, y0 + gj * s, z0 + gk * s);
    }
    return n;
  };

  const tetArr = [];
  const restVolArr = [];
  const cellTets = new Int32Array(cellCount * 6).fill(-1);
  for (let i = 0; i < cellX; i++) {
    for (let j = 0; j < cellY; j++) {
      for (let k = 0; k < cellZ; k++) {
        const ci = cellIndex(i, j, k);
        if (!kept[ci]) continue;
        for (let p = 0; p < 6; p++) {
          const perm = PERMUTATIONS[p];
          const a1 = AXES[perm[0]];
          const a2 = AXES[perm[1]];
          const n0 = getNode(i, j, k);
          const n1 = getNode(i + a1[0], j + a1[1], k + a1[2]);
          const n2 = getNode(i + a1[0] + a2[0], j + a1[1] + a2[1], k + a1[2] + a2[2]);
          const n3 = getNode(i + 1, j + 1, k + 1);

          const p0 = n0 * 3;
          const p1 = n1 * 3;
          const p2 = n2 * 3;
          const p3 = n3 * 3;
          const x0v = nodeArr[p0];
          const y0v = nodeArr[p0 + 1];
          const z0v = nodeArr[p0 + 2];
          const e1x = nodeArr[p1] - x0v;
          const e1y = nodeArr[p1 + 1] - y0v;
          const e1z = nodeArr[p1 + 2] - z0v;
          const e2x = nodeArr[p2] - x0v;
          const e2y = nodeArr[p2 + 1] - y0v;
          const e2z = nodeArr[p2 + 2] - z0v;
          const e3x = nodeArr[p3] - x0v;
          const e3y = nodeArr[p3 + 1] - y0v;
          const e3z = nodeArr[p3 + 2] - z0v;
          const cx = e2y * e3z - e2z * e3y;
          const cy = e2z * e3x - e2x * e3z;
          const cz = e2x * e3y - e2y * e3x;
          let vol = (e1x * cx + e1y * cy + e1z * cz) / 6;

          let t0 = n0;
          let t1 = n1;
          let t2 = n2;
          let t3 = n3;
          if (vol < 0) {
            const swap = t2;
            t2 = t3;
            t3 = swap;
            vol = -vol;
          }
          if (!(vol > 0)) {
            throw new Error(`tetrahedralize produced a non-positive tet volume at cell (${i},${j},${k})`);
          }
          const tetIndex = tetArr.length / 4;
          tetArr.push(t0, t1, t2, t3);
          restVolArr.push(vol);
          cellTets[ci * 6 + p] = tetIndex;
        }
      }
    }
  }

  const nodes = new Float32Array(nodeArr);
  const nodeCount = nodes.length / 3;
  const tets = new Int32Array(tetArr);
  const tetCount = tets.length / 4;
  const restVol = new Float32Array(restVolArr);

  // --- Edges ----------------------------------------------------------------
  const edgeSet = new Set();
  for (let t = 0; t < tetCount; t++) {
    const b = t * 4;
    for (let m = 0; m < 4; m++) {
      for (let n = m + 1; n < 4; n++) {
        const a = tets[b + m];
        const c = tets[b + n];
        edgeSet.add(a < c ? a * nodeCount + c : c * nodeCount + a);
      }
    }
  }
  const edgeCount = edgeSet.size;
  const edges = new Int32Array(edgeCount * 2);
  let cursor = 0;
  for (const key of edgeSet) {
    edges[cursor] = Math.floor(key / nodeCount);
    edges[cursor + 1] = key % nodeCount;
    cursor += 2;
  }

  // --- Inverse masses -------------------------------------------------------
  const nodeVolume = new Float64Array(nodeCount);
  for (let t = 0; t < tetCount; t++) {
    const quarter = restVol[t] / 4;
    const b = t * 4;
    nodeVolume[tets[b]] += quarter;
    nodeVolume[tets[b + 1]] += quarter;
    nodeVolume[tets[b + 2]] += quarter;
    nodeVolume[tets[b + 3]] += quarter;
  }
  const invMass = new Float32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    if (!(nodeVolume[i] > 0)) {
      throw new Error(`tetrahedralize: node ${i} has non-positive rest volume`);
    }
    invMass[i] = 1 / nodeVolume[i];
  }

  // --- Surface embedding ----------------------------------------------------
  const embedTet = new Int32Array(surfaceCount);
  const embedBary = new Float32Array(surfaceCount * 4);
  for (let v = 0; v < surfaceCount; v++) {
    const px = surfacePos[v * 3];
    const py = surfacePos[v * 3 + 1];
    const pz = surfacePos[v * 3 + 2];
    const i = clampCell((px - x0) / s, cellX);
    const j = clampCell((py - y0) / s, cellY);
    const k = clampCell((pz - z0) / s, cellZ);
    const ci = cellIndex(i, j, k);

    let bestTet = -1;
    let bestMin = -Infinity;
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    for (let p = 0; p < 6; p++) {
      const t = cellTets[ci * 6 + p];
      if (t < 0) continue;
      const tb = t * 4;
      const q0 = tets[tb] * 3;
      const q1 = tets[tb + 1] * 3;
      const q2 = tets[tb + 2] * 3;
      const q3 = tets[tb + 3] * 3;
      const ax = nodes[q0];
      const ay = nodes[q0 + 1];
      const az = nodes[q0 + 2];
      const v0x = nodes[q1] - ax;
      const v0y = nodes[q1 + 1] - ay;
      const v0z = nodes[q1 + 2] - az;
      const v1x = nodes[q2] - ax;
      const v1y = nodes[q2 + 1] - ay;
      const v1z = nodes[q2 + 2] - az;
      const v2x = nodes[q3] - ax;
      const v2y = nodes[q3 + 1] - ay;
      const v2z = nodes[q3 + 2] - az;
      const rx = px - ax;
      const ry = py - ay;
      const rz = pz - az;
      const g0x = v1y * v2z - v1z * v2y;
      const g0y = v1z * v2x - v1x * v2z;
      const g0z = v1x * v2y - v1y * v2x;
      const g1x = v2y * v0z - v2z * v0y;
      const g1y = v2z * v0x - v2x * v0z;
      const g1z = v2x * v0y - v2y * v0x;
      const g2x = v0y * v1z - v0z * v1y;
      const g2y = v0z * v1x - v0x * v1z;
      const g2z = v0x * v1y - v0y * v1x;
      const det = v0x * g0x + v0y * g0y + v0z * g0z;
      if (det > -1e-12 && det < 1e-12) continue;
      const invDet = 1 / det;
      // g0 weights node1, g1 weights node2, g2 weights node3; node0 closes.
      const w1 = (rx * g0x + ry * g0y + rz * g0z) * invDet;
      const w2 = (rx * g1x + ry * g1y + rz * g1z) * invDet;
      const w3 = (rx * g2x + ry * g2y + rz * g2z) * invDet;
      const w0 = 1 - w1 - w2 - w3;
      const min = Math.min(w0, w1, w2, w3);
      if (min > bestMin) {
        bestMin = min;
        bestTet = t;
        b0 = w0;
        b1 = w1;
        b2 = w2;
        b3 = w3;
      }
    }
    if (bestTet < 0 || bestMin < -1e-4) {
      throw new Error(
        `tetrahedralize: surface vertex ${v} failed to embed (min barycentric ${bestMin})`
      );
    }
    embedTet[v] = bestTet;
    embedBary[v * 4] = b0;
    embedBary[v * 4 + 1] = b1;
    embedBary[v * 4 + 2] = b2;
    embedBary[v * 4 + 3] = b3;
  }

  return {
    nodes,
    tets,
    edges,
    restVol,
    invMass,
    embedTet,
    embedBary,
    nodeCount,
    tetCount,
    edgeCount,
  };
}
