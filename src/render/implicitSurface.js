import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';

/**
 * Marching-cubes skin for the slime look.
 *
 * The skinned surface can only show a fold as a thin crease; a scalar field
 * built from the solver's tet NODES fuses two touching sheets into one blob, so
 * kneading reads as merging. Colours are carried per node and blended into the
 * field palette, so marbling survives the implicit pass.
 *
 * The field is built by a deposit + separable box blur (never a per-node poly6
 * kernel): every node drops unit weight, trilinearly, into a density grid and
 * its colour into a parallel colour grid; both are then smoothed by three
 * box-blur sweeps per axis. The blur cost is independent of the kernel width,
 * so a wide, smooth envelope (a fold visibly fusing) stays cheap. `addBall` is
 * deliberately avoided: it allocates a Color per call and sums colours
 * unnormalised.
 *
 * `MarchingCubes` local space is the cube [-1, 1]^3 and `update()` samples grid
 * indices 1 .. size-2 with `delta = 2 / size`. We map that cube onto a box
 * around the nodes.
 */

const MAX_POLY_COUNT = 120000;
const BOX_MARGIN = 2.4;
const BLUR_RADIUS_SPACING = 1.1;
const BLUR_REPEATS = 3;

/** Isosurface level as a fraction of the bulk interior density. Designer-tuned. */
export const ISO_FACTOR = 0.42;

/**
 * Which skin to show for the current physics. A plastic body (slime-like) needs
 * the fusing implicit surface; an elastic body (squishy/bouncy) reads best on
 * the smooth skinned surface.
 */
export function chooseRenderMode(params) {
  if (params == null || !Number.isFinite(params.plasticRate)) {
    throw new Error('chooseRenderMode requires a resolved physics object with a finite plasticRate');
  }
  return params.plasticRate > 0 ? 'implicit' : 'skinned';
}

export class ImplicitSurface {
  constructor({ material, body, resolution }) {
    if (!Number.isInteger(resolution) || resolution < 8) {
      throw new Error(`ImplicitSurface requires an integer resolution >= 8; got ${resolution}`);
    }

    this.body = body;
    this.resolution = resolution;
    this.N = resolution;
    this.size2 = resolution * resolution;
    this.size3 = this.size2 * resolution;

    this.mesh = new MarchingCubes(resolution, material, false, true, MAX_POLY_COUNT);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'squish-implicit';

    // Density grid and parallel interleaved colour grid (3 channels).
    this.D = new Float32Array(this.size3);
    this.C = new Float32Array(this.size3 * 3);
    // One scratch ring buffer, shared by every blur line: the window holds
    // 2*r+1 samples of each of the four channels (density + rgb).
    this.ring = new Float32Array(4 * (2 * resolution + 5));

    this.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    this.mesh.geometry.boundingSphere = this.boundingSphere;

    this.first = true;
    this.lastColorVersion = -1;
    this.lastNodeBoundsKey = null;
    this.lastSyncMs = 0;
  }

  /** A cheap signature of the node bounds, used to detect drift while idle. */
  _boundsKey(bounds) {
    return `${bounds.minX}|${bounds.minY}|${bounds.minZ}|${bounds.maxX}|${bounds.maxY}|${bounds.maxZ}`;
  }

  /**
   * Box-blur one line of `D` and the three interleaved channels of `C` in a
   * single traversal, with a sliding running sum and clamped borders. The
   * scratch ring buffer holds the current window of all four channels, so the
   * source can be read before it is overwritten and no per-line copy is needed.
   * `base` is the line's first density index; the colour index is `base*3`.
   */
  _blurLine(base, step, n, r) {
    const w = 2 * r + 1;
    const ring = this.ring;
    if (4 * w > ring.length) {
      throw new Error(`ImplicitSurface blur radius ${r} exceeds the ring buffer (${ring.length})`);
    }
    const inv = 1 / w;
    const D = this.D;
    const C = this.C;

    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    for (let k = 0; k < w; k++) {
      const idx = k - r;
      const src = idx < 0 ? 0 : idx >= n ? n - 1 : idx;
      const od = base + src * step;
      const oc = od * 3;
      const v0 = D[od];
      const v1 = C[oc];
      const v2 = C[oc + 1];
      const v3 = C[oc + 2];
      const k4 = k * 4;
      ring[k4] = v0;
      ring[k4 + 1] = v1;
      ring[k4 + 2] = v2;
      ring[k4 + 3] = v3;
      s0 += v0;
      s1 += v1;
      s2 += v2;
      s3 += v3;
    }

    let head = 0;
    for (let i = 0; i < n; i++) {
      const od = base + i * step;
      const oc = od * 3;
      D[od] = s0 * inv;
      C[oc] = s1 * inv;
      C[oc + 1] = s2 * inv;
      C[oc + 2] = s3 * inv;

      const h4 = head * 4;
      s0 -= ring[h4];
      s1 -= ring[h4 + 1];
      s2 -= ring[h4 + 2];
      s3 -= ring[h4 + 3];

      const add = i + r + 1;
      const src = add >= n ? n - 1 : add;
      const od2 = base + src * step;
      const oc2 = od2 * 3;
      const v0 = D[od2];
      const v1 = C[oc2];
      const v2 = C[oc2 + 1];
      const v3 = C[oc2 + 2];
      ring[h4] = v0;
      ring[h4 + 1] = v1;
      ring[h4 + 2] = v2;
      ring[h4 + 3] = v3;
      s0 += v0;
      s1 += v1;
      s2 += v2;
      s3 += v3;

      head += 1;
      if (head === w) head = 0;
    }
  }

  /** Blur every line running along x (contiguous). */
  _blurX(r) {
    const N = this.N;
    const lines = N * N;
    for (let line = 0; line < lines; line++) {
      this._blurLine(line * N, 1, N, r);
    }
  }

  /** Blur every line running along y. */
  _blurY(r) {
    const N = this.N;
    const size2 = this.size2;
    for (let z = 0; z < N; z++) {
      const zBase = z * size2;
      for (let x = 0; x < N; x++) {
        this._blurLine(zBase + x, N, N, r);
      }
    }
  }

  /** Blur every line running along z. */
  _blurZ(r) {
    const N = this.N;
    const size2 = this.size2;
    for (let y = 0; y < N; y++) {
      const yBase = y * N;
      for (let x = 0; x < N; x++) {
        this._blurLine(yBase + x, size2, N, r);
      }
    }
  }

  /** x, then y, then z, repeated `BLUR_REPEATS` times. */
  _blurRepeat(rx, ry, rz) {
    for (let rep = 0; rep < BLUR_REPEATS; rep++) {
      this._blurX(rx);
      this._blurY(ry);
      this._blurZ(rz);
    }
  }

  /**
   * Rebuild the scalar field and colour palette from the current node state:
   * deposit each node's weight and colour, blur, then hand the grids to
   * `MarchingCubes`. The box is the node bounds expanded by `BOX_MARGIN *
   * spacing` per side so the surface closes; the outermost grid layer is kept
   * empty so the isosurface closes inside the box.
   */
  buildField() {
    const { body } = this;
    const mc = this.mesh;
    const N = this.N;
    const size2 = this.size2;
    const D = this.D;
    const C = this.C;
    D.fill(0);
    C.fill(0);

    const bounds = body.nodeBounds;
    const spacing = body.spacing;
    const margin = BOX_MARGIN * spacing;

    const minX = bounds.minX - margin;
    const minY = bounds.minY - margin;
    const minZ = bounds.minZ - margin;
    const maxX = bounds.maxX + margin;
    const maxY = bounds.maxY + margin;
    const maxZ = bounds.maxZ + margin;

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const hx = (maxX - minX) / 2;
    const hy = (maxY - minY) / 2;
    const hz = (maxZ - minZ) / 2;

    mc.position.set(cx, cy, cz);
    mc.scale.set(hx, hy, hz);

    const cellX = (2 * hx) / N;
    const cellY = (2 * hy) / N;
    const cellZ = (2 * hz) / N;
    const cellVol = cellX * cellY * cellZ;

    const nodePos = body.nodePos;
    const nodeColor = body.nodeColor;
    const nodeCount = body.nodeCount;
    const last = N - 1;

    // Deposit: trilinear unit weight into D and w*nodeColor into C.
    for (let n = 0; n < nodeCount; n++) {
      const n3 = n * 3;
      const px = nodePos[n3];
      const py = nodePos[n3 + 1];
      const pz = nodePos[n3 + 2];

      const gx = ((px - cx) / hx + 1) * (N / 2);
      const gy = ((py - cy) / hy + 1) * (N / 2);
      const gz = ((pz - cz) / hz + 1) * (N / 2);

      let i0 = Math.floor(gx);
      let j0 = Math.floor(gy);
      let k0 = Math.floor(gz);
      if (i0 < 0) i0 = 0;
      else if (i0 > N - 2) i0 = N - 2;
      if (j0 < 0) j0 = 0;
      else if (j0 > N - 2) j0 = N - 2;
      if (k0 < 0) k0 = 0;
      else if (k0 > N - 2) k0 = N - 2;

      const fx = gx - i0;
      const fy = gy - j0;
      const fz = gz - k0;

      const cr = nodeColor[n3];
      const cg = nodeColor[n3 + 1];
      const cb = nodeColor[n3 + 2];

      for (let dz = 0; dz < 2; dz++) {
        const iz = k0 + dz;
        if (iz <= 0 || iz >= last) continue;
        const wz = dz === 0 ? 1 - fz : fz;
        const zOff = size2 * iz;
        for (let dy = 0; dy < 2; dy++) {
          const iy = j0 + dy;
          if (iy <= 0 || iy >= last) continue;
          const wy = dy === 0 ? 1 - fy : fy;
          const yOff = zOff + N * iy;
          const wyz = wz * wy;
          for (let dx = 0; dx < 2; dx++) {
            const ix = i0 + dx;
            if (ix <= 0 || ix >= last) continue;
            const wx = dx === 0 ? 1 - fx : fx;
            const w = wx * wyz;
            const idx = yOff + ix;
            D[idx] += w;
            const c3 = idx * 3;
            C[c3] += w * cr;
            C[c3 + 1] += w * cg;
            C[c3 + 2] += w * cb;
          }
        }
      }
    }

    // Blur radius gives a physical smoothing width of ~1.1*spacing per axis.
    const rx = Math.max(1, Math.round((BLUR_RADIUS_SPACING * spacing) / cellX));
    const ry = Math.max(1, Math.round((BLUR_RADIUS_SPACING * spacing) / cellY));
    const rz = Math.max(1, Math.round((BLUR_RADIUS_SPACING * spacing) / cellZ));

    this._blurRepeat(rx, ry, rz);

    mc.reset();
    const field = mc.field;
    field.set(D);

    // Keep the outermost layer empty so the isosurface closes inside the box.
    for (let iz = 0; iz < N; iz++) {
      const zEdge = iz === 0 || iz === last;
      const zOff = size2 * iz;
      for (let iy = 0; iy < N; iy++) {
        const yEdge = iy === 0 || iy === last;
        const yOff = zOff + N * iy;
        for (let ix = 0; ix < N; ix++) {
          if (zEdge || yEdge || ix === 0 || ix === last) field[yOff + ix] = 0;
        }
      }
    }

    const palette = mc.palette;
    for (let i = 0; i < this.size3; i++) {
      const d = D[i];
      if (d > 1e-6) {
        const inv = 1 / d;
        const c3 = i * 3;
        palette[c3] = C[c3] * inv;
        palette[c3 + 1] = C[c3 + 1] * inv;
        palette[c3 + 2] = C[c3 + 2] * inv;
      }
    }

    mc.isolation = (ISO_FACTOR * cellVol) / (spacing * spacing * spacing);

    this.boundingSphere.center.set(cx, cy, cz);
    this.boundingSphere.radius = Math.hypot(hx, hy, hz);
  }

  /**
   * Rebuild only when the body moved, is being handled, or the colours changed;
   * otherwise keep the last mesh. `lastSyncMs` records the rebuild cost.
   */
  sync() {
    const { body } = this;
    const colorChanged = body.colorVersion !== this.lastColorVersion;
    const moving = body.energy > 1e-3 || body.grabbed || body.press.active;
    const boundsKey = this._boundsKey(body.nodeBounds);
    if (!this.first && !moving && !colorChanged && boundsKey === this.lastNodeBoundsKey) return;

    this.first = false;
    this.lastColorVersion = body.colorVersion;
    this.lastNodeBoundsKey = boundsKey;

    const t0 = performance.now();
    this.buildField();
    this.mesh.update();
    this.lastSyncMs = performance.now() - t0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.removeFromParent();
  }
}
