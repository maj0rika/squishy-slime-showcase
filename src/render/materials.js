import * as THREE from 'three';

/**
 * Tint presets are deliberately separate from shape and physics.
 * Adding a tint = adding one entry here. Nothing else changes.
 */
export const COLOR_PRESETS = [
  { id: 'strawberry', label: '딸기우유', base: '#eeaab4', deep: '#d1828e', sheen: '#fff1f2', sss: '#ef8fa0' },
  { id: 'matcha', label: '말차라떼', base: '#bdd194', deep: '#97ad6e', sheen: '#f4f8e8', sss: '#aac86b' },
  { id: 'soda', label: '소다', base: '#9cc3e6', deep: '#6f9cc4', sheen: '#eaf4ff', sss: '#79b4ea' },
  { id: 'grape', label: '포도', base: '#bfa9e0', deep: '#937cbb', sheen: '#f4eeff', sss: '#a486e0' },
  { id: 'cream', label: '크림', base: '#e8d6b3', deep: '#c9b287', sheen: '#fff9ec', sss: '#e0c488' },
];

/**
 * Paint dollops: the three vivid pigments knead best, plus the five body
 * colours so a dollop can also just reinforce the current body colour.
 * `hex` is the linear source for the body's `nodeColor` field.
 */
export const PAINT_PRESETS = [
  { id: 'lemon', label: '레몬', hex: '#f6dc6b' },
  { id: 'mint', label: '민트', hex: '#8fdcc2' },
  { id: 'cherry', label: '체리', hex: '#e2566e' },
  ...COLOR_PRESETS.map((preset) => ({ id: preset.id, label: preset.label, hex: preset.base })),
];

/**
 * The single directional key that survives the move to image-based lighting.
 * It exists for its shadow only; the HDR provides the light. The material SSS
 * term reads the same colour, so the key lives here as the one source of truth.
 */
export const KEY_COLOR_HEX = 0xfff3e8;

/**
 * Material profiles are separate from shape and colour.
 * `mochi` is the satin TPR squishy profile: a broad soft highlight, a faint
 * clearcoat and a warm subsurface scatter, matched to real 말랑이 photos.
 */
export const MATERIAL_PROFILES = {
  mochi: {
    id: 'mochi',
    label: '모찌 실리콘',
    roughness: 0.52,
    metalness: 0,
    clearcoat: 0.12,
    clearcoatRoughness: 0.5,
    sheen: 0.35,
    sheenRoughness: 0.7,
    specularIntensity: 0.45,
    ior: 1.45,
    envMapIntensity: 1.0,
  },
};

// Fragment-shader injection anchors (three r170 meshphysical.glsl.js).
const ANCHOR_COLOR = '#include <color_fragment>';
const ANCHOR_ROUGHNESS = '#include <roughnessmap_fragment>';
const ANCHOR_NORMAL_MAPS = '#include <normal_fragment_maps>';
const ANCHOR_LIGHTS_END = '#include <lights_fragment_end>';
const ANCHOR_OPAQUE = '#include <opaque_fragment>';

// The shared physical-light chunk is patched per material (never globally), so
// the slime material keeps three's stock diffuse response.
const LIGHTS_CHUNK_NAME = 'lights_physical_pars_fragment';
const LIGHTS_INCLUDE = `#include <${LIGHTS_CHUNK_NAME}>`;
const DIFFUSE_ANCHOR =
  'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );';

// Real wrap + scatter-tinted diffuse. Replaces ONLY the diffuse accumulation
// inside RE_Direct_Physical; the specular `irradiance` stays untouched.
const WRAP_DIFFUSE_GLSL = /* glsl */`float sqNL = dot( geometryNormal, directLight.direction );
float sqWrapNL = clamp( ( sqNL + uWrap ) / ( 1.0 + uWrap ), 0.0, 1.0 );
float sqHardNL = clamp( sqNL, 0.0, 1.0 );
vec3 sqDiffuseIrr = directLight.color * ( sqHardNL + uScatterColor * ( sqWrapNL - sqHardNL ) * uScatterGain );
reflectedLight.directDiffuse += sqDiffuseIrr * BRDF_Lambert( material.diffuseColor );`;

function insertAfter(source, anchor, code) {
  if (!source.includes(anchor)) {
    throw new Error(`Material injection anchor not found: ${anchor}`);
  }
  return source.replace(anchor, `${anchor}\n${code}`);
}

function insertBefore(source, anchor, code) {
  if (!source.includes(anchor)) {
    throw new Error(`Material injection anchor not found: ${anchor}`);
  }
  return source.replace(anchor, `${code}\n${anchor}`);
}

/**
 * Patch three's shared `lights_physical_pars_fragment` chunk for one material.
 * Reads the live `THREE.ShaderChunk` entry, swaps the single diffuse line and
 * throws if the anchor is gone.
 */
function patchLightsChunk() {
  const chunk = THREE.ShaderChunk[LIGHTS_CHUNK_NAME];
  if (typeof chunk !== 'string') {
    throw new Error(`ShaderChunk ${LIGHTS_CHUNK_NAME} is unavailable`);
  }
  if (!chunk.includes(DIFFUSE_ANCHOR)) {
    throw new Error(`Material injection anchor not found: ${DIFFUSE_ANCHOR}`);
  }
  return chunk.replace(DIFFUSE_ANCHOR, WRAP_DIFFUSE_GLSL);
}

/**
 * Texture-free hash gradient noise (iq-style), a 2-octave fbm and a Worley
 * cell field that also returns the per-cell hash. Shared by both skins; every
 * symbol is `sq`-prefixed so it can never collide with a three chunk.
 */
const NOISE_GLSL = /* glsl */`
vec3 sqHash33(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}
float sqNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = dot(sqHash33(i + vec3(0.0, 0.0, 0.0)), f - vec3(0.0, 0.0, 0.0));
  float n100 = dot(sqHash33(i + vec3(1.0, 0.0, 0.0)), f - vec3(1.0, 0.0, 0.0));
  float n010 = dot(sqHash33(i + vec3(0.0, 1.0, 0.0)), f - vec3(0.0, 1.0, 0.0));
  float n110 = dot(sqHash33(i + vec3(1.0, 1.0, 0.0)), f - vec3(1.0, 1.0, 0.0));
  float n001 = dot(sqHash33(i + vec3(0.0, 0.0, 1.0)), f - vec3(0.0, 0.0, 1.0));
  float n101 = dot(sqHash33(i + vec3(1.0, 0.0, 1.0)), f - vec3(1.0, 0.0, 1.0));
  float n011 = dot(sqHash33(i + vec3(0.0, 1.0, 1.0)), f - vec3(0.0, 1.0, 1.0));
  float n111 = dot(sqHash33(i + vec3(1.0, 1.0, 1.0)), f - vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z
  );
}
float sqFbm(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 2; i++) {
    s += a * sqNoise3(p);
    p *= 2.0;
    a *= 0.5;
  }
  return s;
}
vec2 sqWorleyCell(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float d = 1e9;
  vec3 cell = i;
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      for (int z = -1; z <= 1; z++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 o = sqHash33(i + g) * 0.5 + 0.5;
        vec3 r = g + o - f;
        float dd = dot(r, r);
        if (dd < d) { d = dd; cell = i + g; }
      }
    }
  }
  float h = sqHash33(cell).x * 0.5 + 0.5;
  return vec2(sqrt(d), h);
}
`;

/**
 * Deterministic lint fibres stuck to the slightly tacky skin: six short
 * quadratic curves in REST space on the upper half. Fragment distance to a
 * curve below the line width mixes the albedo toward the fibre colour. A cheap
 * per-fibre bounding sphere rejects most fragments before the segment loop.
 */
const FIBRE_GLSL = /* glsl */`
float sqSegDist(vec3 p, vec3 a, vec3 b) {
  vec3 ab = b - a;
  vec3 ap = p - a;
  float t = clamp(dot(ap, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
  return length(ap - ab * t);
}
float sqFibreDist(vec3 p, vec3 a, vec3 b, vec3 c) {
  float best = 1e9;
  vec3 prev = a;
  for (int i = 1; i <= 8; i++) {
    float t = float(i) / 8.0;
    float u = 1.0 - t;
    vec3 pt = u * u * a + 2.0 * u * t * b + t * t * c;
    best = min(best, sqSegDist(p, prev, pt));
    prev = pt;
  }
  return best;
}
const vec3 SQ_FIB_P0[6] = vec3[6](
  vec3(0.30, 0.50, 0.25), vec3(-0.35, 0.45, 0.15), vec3(0.05, 0.75, -0.15),
  vec3(-0.10, 0.72, -0.30), vec3(0.40, 0.35, -0.20), vec3(-0.42, 0.30, 0.10)
);
const vec3 SQ_FIB_P1[6] = vec3[6](
  vec3(0.18, 0.62, 0.32), vec3(-0.28, 0.55, 0.28), vec3(0.16, 0.68, -0.22),
  vec3(-0.16, 0.66, -0.24), vec3(0.48, 0.30, -0.12), vec3(-0.34, 0.26, 0.18)
);
const vec3 SQ_FIB_P2[6] = vec3[6](
  vec3(0.10, 0.68, 0.45), vec3(-0.15, 0.62, 0.35), vec3(0.22, 0.60, -0.35),
  vec3(-0.28, 0.58, -0.12), vec3(0.52, 0.22, -0.05), vec3(-0.30, 0.18, 0.28)
);
const vec3 SQ_FIB_COL[6] = vec3[6](
  vec3(0.75, 0.75, 0.75), vec3(0.78, 0.78, 0.78), vec3(0.95, 0.95, 0.95),
  vec3(0.92, 0.92, 0.90), vec3(0.35, 0.35, 0.35), vec3(0.60, 0.72, 0.85)
);
void sqFibres(vec3 p, float aa, out float hit, out vec3 col) {
  hit = 0.0;
  col = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    vec3 mid = 0.5 * (SQ_FIB_P0[i] + SQ_FIB_P2[i]);
    vec3 rel = p - mid;
    if (dot(rel, rel) < 0.09) {
      float d = sqFibreDist(p, SQ_FIB_P0[i], SQ_FIB_P1[i], SQ_FIB_P2[i]);
      float m = 1.0 - smoothstep(0.0035 - aa, 0.0035 + aa, d);
      col = mix(col, SQ_FIB_COL[i], m);
      hit = max(hit, m);
    }
  }
}
`;

const SSS_UNIFORM_GLSL = /* glsl */`
uniform vec3 uSssColor;
uniform float uSssDistortion;
uniform float uSssPower;
uniform float uSssScale;
uniform float uSssRim;
uniform vec3 uKeyDirView;
uniform vec3 uKeyColor;
`;

/**
 * Barré-Brisebois fast translucency + wrap rim for the glossy slime skin only.
 * `thinExpr` supplies the thin factor (1.0 for the gooey slime).
 */
function sssBlock(thinExpr) {
  return /* glsl */`{
  float sssThin = ${thinExpr};
  vec3 sssV = normalize(vViewPosition);
  vec3 sssL = normalize(uKeyDirView);
  float sssBack = pow(clamp(dot(sssV, -(sssL + normal * uSssDistortion)), 0.0, 1.0), uSssPower) * uSssScale;
  float sssRim = pow(1.0 - clamp(dot(normal, sssV), 0.0, 1.0), 3.0);
  vec3 sss = uSssColor * diffuseColor.rgb * (sssBack * (0.4 + 0.6 * sssThin) + sssRim * uSssRim);
  outgoingLight += sss * uKeyColor;
}`;
}

function makeCommonUniforms(color) {
  return {
    uSssColor: { value: new THREE.Color(color.sss) },
    uSssDistortion: { value: 0.25 },
    uSssPower: { value: 3.0 },
    uSssScale: { value: 0.9 },
    uSssRim: { value: 0.18 },
    uKeyDirView: { value: new THREE.Vector3(0, 1, 0) },
    uKeyColor: { value: new THREE.Color(KEY_COLOR_HEX) },
  };
}

/**
 * The preset's subsurface tint, linearised and normalised so its brightest
 * channel is 1 — a saturated hue, never a dark colour. Drives the wrap diffuse
 * scatter, the indirect fill, the cavity depth and the thin back-scatter.
 */
function scatterColor(color) {
  const result = new THREE.Color(color.sss);
  const max = Math.max(result.r, result.g, result.b);
  if (max > 0) result.multiplyScalar(1 / max);
  return result;
}

export function getColor(id) {
  const preset = COLOR_PRESETS.find((entry) => entry.id === id);
  if (!preset) throw new Error(`Unknown colour preset: ${id}`);
  return preset;
}

export function getMaterialProfile(id) {
  const profile = MATERIAL_PROFILES[id];
  if (!profile) throw new Error(`Unknown material profile: ${id}`);
  return profile;
}

/**
 * Linear RGB of a body or paint colour, ready for the solver's `nodeColor`.
 * `new THREE.Color(hex)` runs the sRGB → linear working-space conversion in
 * r170, so this is the value the body field must be seeded with.
 */
export function getColorLinear(id) {
  const preset =
    PAINT_PRESETS.find((entry) => entry.id === id) ??
    COLOR_PRESETS.find((entry) => entry.id === id);
  if (!preset) throw new Error(`Unknown colour preset: ${id}`);
  const color = new THREE.Color(preset.hex);
  return [color.r, color.g, color.b];
}

/**
 * The satin TPR squishy skin (skinned surface). MeshPhysicalMaterial with
 * vertex colours plus injections in REST space so the surface life stretches
 * with the material: a real wrap + scatter diffuse, a saturated indirect fill,
 * cavity colour depth, deterministic dust specks and lint fibres, a faint
 * grain bump and a thin-region back-scatter.
 */
export function createSquishyMaterial(materialId, colorId) {
  const profile = getMaterialProfile(materialId);
  const color = getColor(colorId);

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: profile.roughness,
    metalness: profile.metalness,
    clearcoat: profile.clearcoat,
    clearcoatRoughness: profile.clearcoatRoughness,
    sheen: profile.sheen,
    sheenRoughness: profile.sheenRoughness,
    sheenColor: new THREE.Color(color.sheen),
    specularIntensity: profile.specularIntensity,
    ior: profile.ior,
    envMapIntensity: profile.envMapIntensity,
    flatShading: false,
  });

  const uniforms = {
    uGrainFreq: { value: 9.0 },
    uBumpScale: { value: 0.0006 },
    uWrap: { value: 0.3 },
    uScatterGain: { value: 1.15 },
    uScatterColor: { value: scatterColor(color) },
    uKeyDirView: { value: new THREE.Vector3(0, 1, 0) },
  };
  material.userData.uniforms = uniforms;
  material.userData.keyDirView = uniforms.uKeyDirView;

  const fragmentPrelude =
    'varying vec3 vRest;\nvarying float vStretch;\nvarying float vCavity;\n' +
    'uniform float uGrainFreq;\nuniform float uBumpScale;\n' +
    'uniform float uWrap;\nuniform float uScatterGain;\n' +
    'uniform vec3 uScatterColor;\nuniform vec3 uKeyDirView;\n' +
    NOISE_GLSL +
    FIBRE_GLSL;

  material.onBeforeCompile = (shader) => {
    const geometry = material.userData.surfaceGeometry;
    if (!geometry || !geometry.getAttribute('aCavity')) {
      throw new Error('Squishy material requires the aCavity geometry attribute');
    }
    for (const key of Object.keys(uniforms)) shader.uniforms[key] = uniforms[key];

    if (!shader.fragmentShader.includes(LIGHTS_INCLUDE)) {
      throw new Error(`Material injection anchor not found: ${LIGHTS_INCLUDE}`);
    }
    shader.fragmentShader = shader.fragmentShader.replace(LIGHTS_INCLUDE, patchLightsChunk());

    shader.vertexShader =
      'attribute vec3 restPos;\nattribute float aStretch;\nattribute float aCavity;\nvarying vec3 vRest;\nvarying float vStretch;\nvarying float vCavity;\n' +
      shader.vertexShader;
    shader.vertexShader = insertAfter(
      shader.vertexShader,
      '#include <begin_vertex>',
      'vRest = restPos;\nvStretch = aStretch;\nvCavity = aCavity;'
    );

    shader.fragmentShader = fragmentPrelude + shader.fragmentShader;

    shader.fragmentShader = insertAfter(
      shader.fragmentShader,
      ANCHOR_COLOR,
      `float sqThin = clamp((vStretch - 1.0) * 0.9, 0.0, 1.0);
float sqH = sqFbm(vRest * uGrainFreq);
float sqAlb = sqNoise3(vRest * 2.3);
diffuseColor.rgb *= (1.0 + sqAlb * 0.03);
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.12 + 0.04, 0.5 * sqThin);
float sqComp = clamp((1.0 - vStretch) * 0.9, 0.0, 1.0);
float sqLum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(sqLum), diffuseColor.rgb, 1.08), sqComp);
diffuseColor.rgb *= 1.0 - 0.35 * vCavity;
diffuseColor.rgb *= mix(vec3(1.0), uScatterColor, 0.18 * vCavity);
vec2 sqCell = sqWorleyCell(vRest * 40.0);
float sqSpeck = (sqCell.x < 0.06 && sqCell.y > 0.93) ? 1.0 : 0.0;
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82), 0.08 * sqSpeck);
float sqFw = length(fwidth(vRest)) + 1e-5;
float sqFibreHit;
vec3 sqFibreCol;
sqFibres(vRest, sqFw, sqFibreHit, sqFibreCol);
diffuseColor.rgb = mix(diffuseColor.rgb, sqFibreCol, 0.55 * sqFibreHit);`
    );

    shader.fragmentShader = insertAfter(
      shader.fragmentShader,
      ANCHOR_ROUGHNESS,
      'roughnessFactor = clamp(roughnessFactor + (sqNoise3(vRest * 1.7) - 0.5) * 0.16 + 0.15 * sqSpeck + 0.1 * vCavity, 0.3, 0.85);'
    );

    shader.fragmentShader = insertAfter(
      shader.fragmentShader,
      ANCHOR_NORMAL_MAPS,
      `{
  vec3 sqDpdx = dFdx(-vViewPosition);
  vec3 sqDpdy = dFdy(-vViewPosition);
  float sqDhx = dFdx(sqH);
  float sqDhy = dFdy(sqH);
  vec3 sqR1 = cross(sqDpdy, normal);
  vec3 sqR2 = cross(normal, sqDpdx);
  float sqDet = dot(sqDpdx, sqR1);
  vec3 sqGrad = sign(sqDet) * (sqDhx * sqR1 + sqDhy * sqR2);
  normal = normalize(abs(sqDet) * normal - uBumpScale * sqGrad);
}`
    );

    shader.fragmentShader = insertAfter(
      shader.fragmentShader,
      ANCHOR_LIGHTS_END,
      'reflectedLight.indirectDiffuse *= mix(vec3(1.0), uScatterColor, 0.22);'
    );

    shader.fragmentShader = insertBefore(
      shader.fragmentShader,
      ANCHOR_OPAQUE,
      `{
  vec3 sqV = normalize(vViewPosition);
  vec3 sqL = normalize(uKeyDirView);
  float sqBack = pow(clamp(dot(sqV, -(sqL + normal * 0.25)), 0.0, 1.0), 3.0) * 0.5 * sqThin;
  outgoingLight += uScatterColor * diffuseColor.rgb * sqBack;
}`
    );
  };

  return material;
}

/**
 * The glossy wet slime skin for the marching-cubes surface. Kept as before: no
 * rest-space attributes, a very weak world-space noise bump and the
 * subsurface term with stronger translucency.
 */
export function createSlimeMaterial(colorId) {
  const color = getColor(colorId);

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.12,
    metalness: 0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.08,
    specularIntensity: 1.0,
    ior: 1.47,
    sheen: 0,
    envMapIntensity: 1.25,
    flatShading: false,
  });

  const uniforms = makeCommonUniforms(color);
  uniforms.uSssScale.value = 1.4;
  uniforms.uSssRim.value = 0.3;
  uniforms.uBumpScale = { value: 0.0012 };
  uniforms.uBumpFreq = { value: 6.0 };
  material.userData.uniforms = uniforms;
  material.userData.keyDirView = uniforms.uKeyDirView;

  material.onBeforeCompile = (shader) => {
    for (const key of Object.keys(uniforms)) shader.uniforms[key] = uniforms[key];

    shader.vertexShader = 'varying vec3 vWorld;\n' + shader.vertexShader;
    shader.vertexShader = insertAfter(
      shader.vertexShader,
      '#include <begin_vertex>',
      'vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;'
    );

    shader.fragmentShader =
      'varying vec3 vWorld;\nuniform float uBumpScale;\nuniform float uBumpFreq;\n' +
      SSS_UNIFORM_GLSL +
      NOISE_GLSL +
      shader.fragmentShader;

    shader.fragmentShader = insertAfter(
      shader.fragmentShader,
      ANCHOR_NORMAL_MAPS,
      `{
  float slimeH = sqFbm(vWorld * uBumpFreq);
  vec3 slimeDpdx = dFdx(-vViewPosition);
  vec3 slimeDpdy = dFdy(-vViewPosition);
  float slimeDhx = dFdx(slimeH);
  float slimeDhy = dFdy(slimeH);
  vec3 slimeR1 = cross(slimeDpdy, normal);
  vec3 slimeR2 = cross(normal, slimeDpdx);
  float slimeDet = dot(slimeDpdx, slimeR1);
  vec3 slimeGrad = sign(slimeDet) * (slimeDhx * slimeR1 + slimeDhy * slimeR2);
  normal = normalize(abs(slimeDet) * normal - uBumpScale * slimeGrad);
}`
    );

    shader.fragmentShader = insertBefore(
      shader.fragmentShader,
      ANCHOR_OPAQUE,
      sssBlock('1.0')
    );
  };

  return material;
}

/**
 * Tint-only update: never rebuilds geometry, never touches the simulation.
 * Refreshes the sheen, the squishy scatter tint (normalised) and the slime
 * subsurface tint from the current colour preset.
 */
export function applyColor(material, colorId) {
  const color = getColor(colorId);
  material.sheenColor.set(color.sheen);
  const uniforms = material.userData.uniforms;
  if (!uniforms) {
    throw new Error('applyColor: material has no userData.uniforms');
  }
  if (uniforms.uScatterColor) {
    uniforms.uScatterColor.value.copy(scatterColor(color));
  }
  if (uniforms.uSssColor) {
    uniforms.uSssColor.value.set(color.sss);
  }
}
