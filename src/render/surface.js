import * as THREE from 'three';

/**
 * Bridges the simulation buffer and the render mesh.
 *
 * The GPU reads the exact Float32Array the solver writes — there is no copy,
 * no interpolation layer, no "visual approximation" of the physics.
 */
export class Surface {
  constructor(geometry, material, body) {
    this.body = body;
    this.geometry = geometry;

    this.positionAttr = new THREE.BufferAttribute(body.pos, 3);
    this.positionAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.positionAttr);

    // Vertex colours come straight from the solver's marbled colour field.
    // `body.surfaceColor` is one Float32Array for the body's whole lifetime.
    this.colorAttr = new THREE.BufferAttribute(body.surfaceColor, 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('color', this.colorAttr);
    this.colorVersion = -1;

    // The micro-surface material samples the REST position (so the pores
    // stretch with the material) and the per-vertex stretch ratio (so stretched
    // skin reads smoother). `restPos` is a static copy; `aStretch` is the
    // solver's `surfaceStretch` instance, updated only when its version moves.
    this.restAttr = new THREE.BufferAttribute(new Float32Array(body.rest), 3);
    geometry.setAttribute('restPos', this.restAttr);

    this.stretchAttr = new THREE.BufferAttribute(body.surfaceStretch, 1);
    this.stretchAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aStretch', this.stretchAttr);
    this.stretchVersion = -1;

    this.normalAttr = geometry.getAttribute('normal');
    this.normalAttr.setUsage(THREE.DynamicDrawUsage);
    this.normalArray = this.normalAttr.array;
    this.index = geometry.getIndex().array;
    this.count = body.count;

    // Surface CSR adjacency built once from the geometry index; the cavity term
    // averages a vertex against its one-ring, so it needs the neighbour list.
    const nbrStart = new Int32Array(this.count + 1);
    for (let f = 0; f < this.index.length; f += 3) {
      nbrStart[this.index[f] + 1] += 2;
      nbrStart[this.index[f + 1] + 1] += 2;
      nbrStart[this.index[f + 2] + 1] += 2;
    }
    for (let i = 0; i < this.count; i++) nbrStart[i + 1] += nbrStart[i];
    const nbrs = new Int32Array(nbrStart[this.count]);
    const cursor = nbrStart.slice(0, this.count);
    const pushEdge = (a, b) => {
      nbrs[cursor[a]++] = b;
    };
    for (let f = 0; f < this.index.length; f += 3) {
      const a = this.index[f];
      const b = this.index[f + 1];
      const c = this.index[f + 2];
      pushEdge(a, b);
      pushEdge(a, c);
      pushEdge(b, a);
      pushEdge(b, c);
      pushEdge(c, a);
      pushEdge(c, b);
    }
    this.nbrStart = nbrStart;
    this.nbrs = nbrs;

    // Mean rest edge length, computed once from `body.rest`; normalises the raw
    // cavity signal so it is independent of the mesh resolution.
    const rest = body.rest;
    let edgeSum = 0;
    let edgeCount = 0;
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      for (let k = nbrStart[i]; k < nbrStart[i + 1]; k++) {
        const j3 = nbrs[k] * 3;
        const dx = rest[j3] - rest[i3];
        const dy = rest[j3 + 1] - rest[i3 + 1];
        const dz = rest[j3 + 2] - rest[i3 + 2];
        edgeSum += Math.sqrt(dx * dx + dy * dy + dz * dz);
        edgeCount += 1;
      }
    }
    if (edgeCount === 0) throw new Error('Surface: mesh has no edges');
    this.meanRestEdge = edgeSum / edgeCount;

    // Per-vertex cavity shading: convex → 0, concave crease → 1. Cheap,
    // deterministic stand-in for screen-space occlusion.
    this.cavity = new Float32Array(this.count);
    this.cavityTmp = new Float32Array(this.count);
    this.cavityAttr = new THREE.BufferAttribute(this.cavity, 1);
    this.cavityAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aCavity', this.cavityAttr);

    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    if (!geometry.boundingBox) geometry.computeBoundingBox();

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'squish-surface';

    // The squishy material reads the cavity attribute; give it the geometry so
    // it can fail loudly at compile time if the attribute is missing.
    if (material.userData) material.userData.surfaceGeometry = geometry;
  }

  sync() {
    this.positionAttr.needsUpdate = true;

    const { body } = this;

    if (body.colorVersion !== this.colorVersion) {
      this.colorVersion = body.colorVersion;
      this.colorAttr.needsUpdate = true;
    }

    if (body.stretchVersion !== this.stretchVersion) {
      this.stretchVersion = body.stretchVersion;
      this.stretchAttr.needsUpdate = true;
    }

    if (body.normalsDirty) {
      this.recomputeNormals();
      this.recomputeCavity();
      body.normalsDirty = false;
    }

    const bounds = body.bounds;
    this.geometry.boundingSphere.center.set(bounds.cx, bounds.cy, bounds.cz);
    this.geometry.boundingSphere.radius = bounds.radius + 0.05;
    this.geometry.boundingBox.min.set(bounds.minX, bounds.minY, bounds.minZ);
    this.geometry.boundingBox.max.set(bounds.maxX, bounds.maxY, bounds.maxZ);
  }

  recomputeNormals() {
    const { normalArray, index, count } = this;
    const pos = this.body.pos;

    normalArray.fill(0);

    for (let f = 0; f < index.length; f += 3) {
      const a = index[f] * 3;
      const b = index[f + 1] * 3;
      const c = index[f + 2] * 3;

      const abx = pos[b] - pos[a];
      const aby = pos[b + 1] - pos[a + 1];
      const abz = pos[b + 2] - pos[a + 2];
      const acx = pos[c] - pos[a];
      const acy = pos[c + 1] - pos[a + 1];
      const acz = pos[c + 2] - pos[a + 2];

      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;

      normalArray[a] += nx;
      normalArray[a + 1] += ny;
      normalArray[a + 2] += nz;
      normalArray[b] += nx;
      normalArray[b + 1] += ny;
      normalArray[b + 2] += nz;
      normalArray[c] += nx;
      normalArray[c + 1] += ny;
      normalArray[c + 2] += nz;
    }

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const nx = normalArray[i3];
      const ny = normalArray[i3 + 1];
      const nz = normalArray[i3 + 2];
      const inv = 1 / Math.max(Math.sqrt(nx * nx + ny * ny + nz * nz), 1e-8);
      normalArray[i3] = nx * inv;
      normalArray[i3 + 1] = ny * inv;
      normalArray[i3 + 2] = nz * inv;
    }

    this.normalAttr.needsUpdate = true;
  }

  /**
   * Per-vertex cavity from the current geometry: a vertex whose one-ring mean
   * sits in front of it along the normal (a concave crease) reads positive.
   * One Jacobi smoothing pass keeps the field continuous across the surface.
   * Runs only when the normals were recomputed, i.e. only while moving.
   */
  recomputeCavity() {
    const { normalArray, nbrStart, nbrs, count } = this;
    const pos = this.body.pos;
    const invEdge = 1 / this.meanRestEdge;
    const cav = this.cavity;

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const start = nbrStart[i];
      const end = nbrStart[i + 1];
      const m = end - start;
      if (m === 0) {
        cav[i] = 0;
        continue;
      }
      let mx = 0;
      let my = 0;
      let mz = 0;
      for (let k = start; k < end; k++) {
        const j3 = nbrs[k] * 3;
        mx += pos[j3];
        my += pos[j3 + 1];
        mz += pos[j3 + 2];
      }
      const inv = 1 / m;
      mx = mx * inv - pos[i3];
      my = my * inv - pos[i3 + 1];
      mz = mz * inv - pos[i3 + 2];
      const raw =
        (mx * normalArray[i3] +
          my * normalArray[i3 + 1] +
          mz * normalArray[i3 + 2]) *
        invEdge;
      cav[i] = Math.min(Math.max(raw * 6.0, 0), 1);
    }

    const tmp = this.cavityTmp;
    for (let i = 0; i < count; i++) {
      const start = nbrStart[i];
      const end = nbrStart[i + 1];
      const m = end - start;
      if (m === 0) {
        tmp[i] = cav[i];
        continue;
      }
      let sum = 0;
      for (let k = start; k < end; k++) sum += cav[nbrs[k]];
      tmp[i] = 0.5 * (cav[i] + sum / m);
    }
    cav.set(tmp);
    this.cavityAttr.needsUpdate = true;
  }
}
