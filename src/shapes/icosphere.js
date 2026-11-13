import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * The slime silhouette is a unit sphere pushed through a deterministic
 * profile map. Everything that makes it read as a "pudding" lives here:
 * vertical squash, a soft flattened contact patch, a slight foot flare and
 * a whisper of organic asymmetry. No randomness — every run is identical.
 *
 * The mesh is welded into a single closed surface before the profile map:
 * normal and uv attributes are dropped first, otherwise `mergeVertices` would
 * keep the UV seam vertices split and the surface would crack open when pulled.
 */

const FLOOR = -0.66;
const SOFTNESS = 0.18;

// Organic imperfection: a deterministic 2-octave noise displaces every vertex
// along its own direction (≈ 2 % of the size), faded out near the floor so the
// contact patch stays flat.
const IMPERFECTION_AMPLITUDE = 0.04;
const IMPERFECTION_SEED = 11.317;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function hash3(ix, iy, iz) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(iz, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function valueNoise3(x, y, z) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const c000 = hash3(ix, iy, iz);
  const c100 = hash3(ix + 1, iy, iz);
  const c010 = hash3(ix, iy + 1, iz);
  const c110 = hash3(ix + 1, iy + 1, iz);
  const c001 = hash3(ix, iy, iz + 1);
  const c101 = hash3(ix + 1, iy, iz + 1);
  const c011 = hash3(ix, iy + 1, iz + 1);
  const c111 = hash3(ix + 1, iy + 1, iz + 1);
  const x00 = c000 + (c100 - c000) * ux;
  const x10 = c010 + (c110 - c010) * ux;
  const x01 = c001 + (c101 - c001) * ux;
  const x11 = c011 + (c111 - c011) * ux;
  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;
  return y0 + (y1 - y0) * uz;
}

/** 2 octaves of deterministic value noise, in [-1, 1]. */
function fbm3(x, y, z) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let o = 0; o < 2; o++) {
    sum += amp * (valueNoise3(x * freq, y * freq, z * freq) * 2 - 1);
    freq *= 2;
    amp *= 0.5;
  }
  return sum;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** C1-continuous smooth maximum. Gives a rounded bottom instead of a hard rim. */
function smoothMax(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

/**
 * Pick a simulation/render resolution that fits the device.
 *
 * three's PolyhedronGeometry subdivides each face into (detail + 1)^2
 * triangles, so vertex count is 10 * (detail + 1)^2 + 2:
 *   detail 15 →  2 562 verts
 *   detail 23 →  5 762 verts
 */
export function pickDetail() {
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency ?? 8;
  const memory = navigator.deviceMemory ?? 8;
  return coarsePointer || cores <= 4 || memory <= 4 ? 15 : 23;
}

/**
 * Tetrahedral grid spacing for the volumetric solver. Smaller spacing is a
 * finer solid but costs more; coarse devices get a coarser fill.
 */
export function pickSpacing() {
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency ?? 8;
  const memory = navigator.deviceMemory ?? 8;
  return coarsePointer || cores <= 4 || memory <= 4 ? 0.24 : 0.17;
}

/**
 * @param {number} detail icosphere subdivision level
 * @returns {{ geometry: THREE.BufferGeometry, rest: Float32Array, vertexCount: number, bounds: { min: number[], max: number[] } }}
 */
export function buildBlobGeometry(detail) {
  const source = new THREE.IcosahedronGeometry(1, detail);
  source.deleteAttribute('normal');
  source.deleteAttribute('uv');
  const geometry = mergeVertices(source, 1e-5);
  source.dispose();

  const expected = 10 * (detail + 1) * (detail + 1) + 2;
  if (geometry.getAttribute('position').count !== expected) {
    throw new Error(
      `Blob mesh merge failed: ${geometry.getAttribute('position').count} vertices, expected ${expected}`
    );
  }

  const position = geometry.getAttribute('position');
  const vertexCount = position.count;
  const rest = new Float32Array(vertexCount * 3);

  for (let i = 0; i < vertexCount; i++) {
    const x0 = position.getX(i);
    const y0 = position.getY(i);
    const z0 = position.getZ(i);

    const inv = 1 / Math.hypot(x0, y0, z0);
    const dx = x0 * inv;
    const dz = z0 * inv;
    const dy = y0 * inv;

    let x = dx;
    let y = dy;
    let z = dz;

    // 1. soften the underside into a rounded contact patch
    y = smoothMax(y, FLOOR, SOFTNESS);

    // 2. widen the base so the widest point sits at the contact rim
    const foot = smoothstep(0.3, FLOOR, y);
    const flare = 1 + 0.14 * Math.pow(foot, 1.6);
    x *= flare;
    z *= flare;

    // 3. quiet, deterministic asymmetry so it never reads as a perfect sphere
    const angle = Math.atan2(z, x);
    const asym =
      1 +
      0.018 * Math.sin(3 * angle + 1.1) * (1 - y * y) +
      0.012 * Math.cos(2.3 * y + 0.4);
    x *= asym;
    z *= asym;
    y += 0.012 * Math.sin(2 * angle + 0.6);

    // 4. organic imperfection: push along the surface direction by a small
    //    deterministic noise, faded to 0 near the floor so the flat contact
    //    patch stays flat, then a gentle asymmetric squash in x.
    const fade = smoothstep(FLOOR + 0.25, FLOOR + 0.45, y);
    const disp =
      IMPERFECTION_AMPLITUDE *
      fbm3(
        dx * 1.7 + IMPERFECTION_SEED,
        dy * 1.7 + IMPERFECTION_SEED,
        dz * 1.7 + IMPERFECTION_SEED
      ) *
      fade;
    x += dx * disp;
    y += dy * disp;
    z += dz * disp;
    x *= 1.0 + 0.025 * Math.sin(1.3 * z + 0.4);

    rest[i * 3] = x;
    rest[i * 3 + 1] = y;
    rest[i * 3 + 2] = z;
  }

  // Sit the lowest vertex exactly on y = 0 so the floor contact is honest.
  let minY = Infinity;
  for (let i = 1; i < rest.length; i += 3) {
    if (rest[i] < minY) minY = rest[i];
  }
  for (let i = 1; i < rest.length; i += 3) {
    rest[i] -= minY;
  }

  position.array.set(rest);
  position.needsUpdate = true;

  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const bb = geometry.boundingBox;
  const bounds = {
    min: [bb.min.x, bb.min.y, bb.min.z],
    max: [bb.max.x, bb.max.y, bb.max.z],
  };

  return { geometry, rest, vertexCount, bounds };
}
