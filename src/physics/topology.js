/**
 * Closed-surface topology built from a triangle index buffer.
 *
 * Pure JavaScript on purpose: no three.js import, so the solver and its tests
 * run in Node. The mesh is expected to be a closed 2-manifold (a sphere): every
 * undirected edge is shared by exactly two triangles, with no duplicated seam
 * vertices. Anything else is a build error and throws.
 */

/**
 * @param {Uint32Array|Uint16Array|number[]} index triangle vertex indices
 * @param {number} vertexCount number of vertices referenced by the index
 * @returns {{ edges: Int32Array, bends: Int32Array, tris: Uint32Array,
 *             edgeCount: number, bendCount: number, triCount: number }}
 */
export function buildTopology(index, vertexCount) {
  if (!index || index.length === 0 || index.length % 3 !== 0) {
    throw new Error(
      `buildTopology requires a triangle index; got ${index ? index.length : 0} entries`
    );
  }

  const triCount = index.length / 3;
  const edgeMap = new Map();

  for (let t = 0; t < triCount; t++) {
    const a = index[t * 3];
    const b = index[t * 3 + 1];
    const c = index[t * 3 + 2];
    accumulateEdge(edgeMap, a, b, c, vertexCount);
    accumulateEdge(edgeMap, b, c, a, vertexCount);
    accumulateEdge(edgeMap, c, a, b, vertexCount);
  }

  const edgeCount = edgeMap.size;
  const edges = new Int32Array(edgeCount * 2);
  const bends = new Int32Array(edgeCount * 2);
  let bendCount = 0;
  let cursor = 0;

  for (const entry of edgeMap.values()) {
    if (entry.count !== 2) {
      throw new Error(
        `Blob mesh is not a closed 2-manifold: edge (${entry.lo}, ${entry.hi}) is used by ` +
          `${entry.count} triangles (expected 2)`
      );
    }
    edges[cursor] = entry.lo;
    edges[cursor + 1] = entry.hi;
    bends[cursor] = entry.opposite[0];
    bends[cursor + 1] = entry.opposite[1];
    cursor += 2;
    bendCount += 1;
  }

  const euler = vertexCount - edgeCount + triCount;
  if (euler !== 2) {
    throw new Error(
      `Blob mesh is not a sphere: Euler characteristic ${euler} ` +
        `(V=${vertexCount} E=${edgeCount} F=${triCount})`
    );
  }

  return {
    edges,
    bends,
    tris: new Uint32Array(index),
    edgeCount,
    bendCount,
    triCount,
  };
}

function accumulateEdge(map, a, b, opposite, vertexCount) {
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  const key = lo * vertexCount + hi;
  const entry = map.get(key);
  if (!entry) {
    map.set(key, { lo, hi, opposite: [opposite, -1], count: 1 });
    return;
  }
  if (entry.count >= 2) {
    entry.count += 1;
    return;
  }
  entry.opposite[entry.count] = opposite;
  entry.count += 1;
}
