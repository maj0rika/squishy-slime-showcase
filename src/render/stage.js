import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { GroundedSkybox } from 'three/addons/objects/GroundedSkybox.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { CONFIG } from '../config.js';
import { KEY_COLOR_HEX } from './materials.js';

/**
 * The toy sits in a real room: a ground-projected HDRI panorama is both the
 * background and the image-based light, a single shadow-casting key adds the
 * sun, and a shadow catcher anchors the object to the floor. The object is the
 * subject.
 */

export const KEY_OFFSET = new THREE.Vector3(3.5, 4.5, -3.0);
const CONTACT_FADE_RATE = 6;
const FLOOR_Y = 0;
const SHADOW_OPACITY = 0.45;

/** Poly Haven `lebombo` (CC0): a real room, desktop 2k / mobile 1k. */
const HDRI_URL_DESKTOP =
  'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/lebombo_2k.hdr';
const HDRI_URL_MOBILE =
  'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/lebombo_1k.hdr';

/** Ground-projected skybox geometry, designer-tuned. */
export const GROUND_HEIGHT = 18;
export const GROUND_RADIUS = 160;
/** Environment rotation; the skybox and the IBL always share this value. */
export const ENV_ROTATION_Y = 4.71;
/** Khronos PBR Neutral exposure, designer-tuned. */
export const EXPOSURE = 1.2;
/** Normalised world-space direction of the single shadow key. */
export const KEY_DIR_WORLD = new THREE.Vector3().copy(KEY_OFFSET).normalize();

/**
 * Final "film" pass, applied in display space after OutputPass: a soft
 * vignette and a very fine animated luminance grain.
 */
const FilmShader = {
  name: 'SquishFilmShader',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uVignetteStrength: { value: 0.06 },
    uVignetteRadius: { value: 0.85 },
    uGrain: { value: 0.012 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uVignetteStrength;
    uniform float uVignetteRadius;
    uniform float uGrain;
    varying vec2 vUv;
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float dist = distance(vUv, vec2(0.5)) * 1.41421356;
      color.rgb *= 1.0 - uVignetteStrength * smoothstep(uVignetteRadius, 1.0, dist);
      float n = fract(sin(dot(vUv * uResolution + uTime, vec2(12.9898, 78.233))) * 43758.5453);
      color.rgb += (n - 0.5) * 2.0 * uGrain;
      gl_FragColor = color;
    }
  `,
};

function makeContactShadowTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2
  );
  gradient.addColorStop(0, 'rgba(70, 48, 44, 0.62)');
  gradient.addColorStop(0.45, 'rgba(70, 48, 44, 0.27)');
  gradient.addColorStop(0.74, 'rgba(70, 48, 44, 0.07)');
  gradient.addColorStop(1, 'rgba(70, 48, 44, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class Stage {
  constructor(canvas, { mobile }) {
    this.mobile = mobile;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = EXPOSURE;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;

    // No scene.background and no fog: the ground-projected skybox is the world.
    this.scene = new THREE.Scene();
    this.scene.environmentIntensity = 0.8;

    const shadowSize = mobile ? CONFIG.render.mobileShadowMapSize : CONFIG.render.shadowMapSize;

    // ONE shadow-casting key; the HDR provides the fill. The rim and hemisphere
    // lights are gone.
    this.key = new THREE.DirectionalLight(KEY_COLOR_HEX, 3.5);
    this.key.position.copy(KEY_OFFSET);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(shadowSize, shadowSize);
    this.key.shadow.camera.left = -3.4;
    this.key.shadow.camera.right = 3.4;
    this.key.shadow.camera.top = 3.4;
    this.key.shadow.camera.bottom = -3.4;
    this.key.shadow.camera.near = 0.5;
    this.key.shadow.camera.far = 16;
    this.key.shadow.radius = 14;
    this.key.shadow.intensity = 0.7;
    this.key.shadow.blurSamples = 12;
    this.key.shadow.bias = -0.0004;
    this.key.target.position.set(0, 0, 0);
    this.scene.add(this.key);
    this.scene.add(this.key.target);

    // Shadow catcher: a large invisible plane that receives only the key's
    // shadow, anchoring the object to the floor of the room.
    this.shadowCatcher = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.ShadowMaterial({ opacity: SHADOW_OPACITY })
    );
    this.shadowCatcher.rotation.x = -Math.PI / 2;
    this.shadowCatcher.position.y = 0.001;
    this.shadowCatcher.receiveShadow = true;
    this.shadowCatcher.name = 'shadow-catcher';
    this.scene.add(this.shadowCatcher);

    // Image-based lighting from the ground-projected room panorama. `ready`
    // resolves once the HDR and the skybox are in place; a load failure rejects
    // with the original error (no substitute environment).
    this.skybox = null;
    this.envRenderTarget = null;
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.ready = new Promise((resolve, reject) => {
      const loader = new RGBELoader();
      loader.load(
        mobile ? HDRI_URL_MOBILE : HDRI_URL_DESKTOP,
        (texture) => {
          texture.mapping = THREE.EquirectangularReflectionMapping;
          this.skybox = new GroundedSkybox(texture, GROUND_HEIGHT, GROUND_RADIUS);
          this.skybox.position.y = GROUND_HEIGHT - 0.01;
          this.scene.add(this.skybox);
          this.setEnvironmentRotation(ENV_ROTATION_Y);
          this.envRenderTarget = this.pmrem.fromEquirectangular(texture);
          this.scene.environment = this.envRenderTarget.texture;
          this.pmrem.dispose();
          this.pmrem = null;
          resolve();
        },
        undefined,
        (error) => {
          this.pmrem.dispose();
          this.pmrem = null;
          reject(error);
        }
      );
    });

    this.contactShadow = this.createContactShadow();
    this.scene.add(this.contactShadow);
    this.contactShadowOpacity = this.contactShadow.material.opacity;
    this.contactShadowScale = 1;

    // The stage owns the two skins of the same body: the smooth skinned surface
    // and the implicit (marching-cubes) surface. Exactly one is visible; the
    // skinned mesh stays the pointer's raycast target even while hidden
    // (raycasting does not test `visible`).
    this.skinnedMesh = null;
    this.implicitMesh = null;
    this.renderMode = 'skinned';

    // Post chain (built lazily on the first render, when the camera is known).
    this.composer = null;
    this.renderPass = null;
    this.outputPass = null;
    this.filmPass = null;

    this.materials = [];
    this._keyView = new THREE.Vector3();
    this._size = { width: 1, height: 1, pixelRatio: 1 };
  }

  /**
   * One setter keeps the skybox panorama and the image-based light in step.
   */
  setEnvironmentRotation(y) {
    this.scene.environmentRotation.y = y;
    if (this.skybox) this.skybox.rotation.y = y;
  }

  setBodyMeshes({ skinned, implicit }) {
    this.skinnedMesh = skinned ?? null;
    this.implicitMesh = implicit ?? null;
  }

  setRenderMode(mode) {
    if (mode !== 'implicit' && mode !== 'skinned') {
      throw new Error(`Unknown render mode: ${mode}`);
    }
    this.renderMode = mode;
    if (this.skinnedMesh) this.skinnedMesh.visible = mode === 'skinned';
    if (this.implicitMesh) this.implicitMesh.visible = mode === 'implicit';
  }

  /**
   * Register a material whose `uKeyDirView` uniform must track the camera every
   * frame. The material must carry its uniform on `userData.keyDirView`.
   */
  registerMaterial(material) {
    if (!material || !material.userData || !material.userData.keyDirView) {
      throw new Error('Stage.registerMaterial: material has no userData.keyDirView');
    }
    if (!this.materials.includes(material)) this.materials.push(material);
  }

  createContactShadow() {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial({
      map: makeContactShadowTexture(),
      transparent: true,
      depthWrite: false,
      opacity: 0,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.002;
    mesh.renderOrder = 2;
    return mesh;
  }

  _buildComposer(camera) {
    const { width, height, pixelRatio } = this._size;
    const renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: this.mobile ? 0 : 4,
    });

    this.composer = new EffectComposer(this.renderer, renderTarget);
    this.composer.setPixelRatio(pixelRatio);

    this.renderPass = new RenderPass(this.scene, camera);
    this.composer.addPass(this.renderPass);

    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    this.filmPass = new ShaderPass(FilmShader);
    this.composer.addPass(this.filmPass);

    this.composer.setSize(width, height);
    this.filmPass.uniforms.uResolution.value.set(width * pixelRatio, height * pixelRatio);
  }

  resize(width, height, pixelRatio) {
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this._size = { width, height, pixelRatio };

    if (this.composer) {
      this.composer.setPixelRatio(pixelRatio);
      this.composer.setSize(width, height);
      this.filmPass.uniforms.uResolution.value.set(width * pixelRatio, height * pixelRatio);
    }
  }

  update({ centroid, contact, dt }) {
    this.key.position.set(
      centroid.x + KEY_OFFSET.x,
      centroid.y + KEY_OFFSET.y,
      centroid.z + KEY_OFFSET.z
    );
    this.key.target.position.set(centroid.x, centroid.y, centroid.z);

    const s = Math.max(contact.radius, 0.35) * 2.3;
    this.contactShadow.position.set(contact.x, 0.002, contact.z);
    this.contactShadow.scale.set(s, s, 1);

    const target =
      this.contactShadowScale *
      0.7 *
      THREE.MathUtils.clamp(1 - (contact.minY - FLOOR_Y) / 0.7, 0, 1);
    const k = 1 - Math.exp(-CONTACT_FADE_RATE * dt);
    this.contactShadowOpacity += (target - this.contactShadowOpacity) * k;
    this.contactShadow.material.opacity = this.contactShadowOpacity;
  }

  render(camera) {
    if (!this.composer) this._buildComposer(camera);
    this.renderPass.camera = camera;

    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    this._keyView.copy(KEY_DIR_WORLD).transformDirection(camera.matrixWorldInverse);
    for (let i = 0; i < this.materials.length; i++) {
      this.materials[i].userData.keyDirView.value.copy(this._keyView);
    }

    this.filmPass.uniforms.uTime.value = performance.now() * 0.001;
    this.composer.render();
  }

  dispose() {
    if (this.envRenderTarget) this.envRenderTarget.dispose();
    if (this.pmrem) this.pmrem.dispose();
    if (this.skybox) {
      this.skybox.geometry.dispose();
      this.skybox.material.map.dispose();
      this.skybox.material.dispose();
    }
    if (this.outputPass) this.outputPass.dispose();
    if (this.filmPass) this.filmPass.dispose();
    if (this.composer) this.composer.dispose();
    this.shadowCatcher.geometry.dispose();
    this.shadowCatcher.material.dispose();
    this.contactShadow.geometry.dispose();
    this.contactShadow.material.map.dispose();
    this.contactShadow.material.dispose();
    this.renderer.dispose();
  }
}
