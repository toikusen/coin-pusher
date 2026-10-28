import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

/**
 * Loads the winter cabinet: GLB, its baked lightmap and the reflection HDRI. Delivered for three.js
 * r184 and run here on the project's r185 - the shader chunk patched below is identical in both,
 * and the guard throws if a future upgrade changes it.
 */
export async function loadCoinPusher(renderer, {
  baseURL, // absolute URL with a trailing slash; the game passes models/winter/
  lightmapFile = 'coin_pusher_lightmap_512.exr',
  reflectionFile = 'hdri/venice_sunset_512.hdr',
} = {}) {
  const url = (name) => new URL(name, baseURL).href;
  const [gltf, lightmap, reflection] = await Promise.all([
    new GLTFLoader().loadAsync(url('coin_pusher.glb')),
    new EXRLoader().loadAsync(url(lightmapFile)),
    (reflectionFile.toLowerCase().endsWith('.exr') ? new EXRLoader() : new HDRLoader()).loadAsync(url(reflectionFile)),
  ]);
  lightmap.colorSpace = THREE.LinearSRGBColorSpace;
  // EXRLoader emits scanlines in the opposite order to glTF image textures.
  lightmap.flipY = true;
  lightmap.channel = 1; // glTF TEXCOORD_1 -> three.js geometry.attributes.uv1
  lightmap.minFilter = THREE.LinearFilter;
  lightmap.magFilter = THREE.LinearFilter;
  lightmap.generateMipmaps = false;
  lightmap.needsUpdate = true;
  reflection.mapping = THREE.EquirectangularReflectionMapping;
  reflection.colorSpace = THREE.LinearSRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const reflectionTarget = pmrem.fromEquirectangular(reflection);
  let currentReflectionTarget = reflectionTarget;
  reflection.dispose();
  pmrem.dispose();
  const materials = new Map();
  const bakedMeshes = [];
  gltf.scene.traverse((object) => {
    if (!object.isMesh || !object.userData.lightmap) return;
    if (!object.geometry.getAttribute('uv1')) {
      throw new Error(`Missing lightmap UV1: ${object.name}`);
    }
    const convert = (original) => {
      if (materials.has(original)) return materials.get(original);
      const material = original.clone();
      material.lightMap = lightmap;
      material.lightMapIntensity = 1;
      material.envMap = reflectionTarget.texture;
      material.envMapIntensity = 1;
      // Occlusion is already captured by the bake.
      material.aoMap = null;
      // Keep environment specular reflections, without adding diffuse light twice.
      material.onBeforeCompile = (shader) => {
        const chunk = THREE.ShaderChunk.lights_fragment_maps;
        const line = 'iblIrradiance += getIBLIrradiance( geometryNormal );';
        if (!chunk.includes(line)) throw new Error('Shader changed: re-check the lightmap patch against this three.js release.');
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <lights_fragment_maps>', chunk.replace(line, '')
        );
      };
      material.customProgramCacheKey = () => 'coin-pusher-baked-r184-v1';
      material.needsUpdate = true;
      materials.set(original, material);
      return material;
    };
    object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material);
    object.castShadow = false;
    object.receiveShadow = false;
    bakedMeshes.push(object);
  });
  if (!bakedMeshes.length) throw new Error('GLB contains no lightmap receiver tags.');
  return {
    scene: gltf.scene,
    bakedMeshes,
    lightmap,
    registerReflectionMaterial(material) {
      materials.set(material, material);
    },
    setReflection(texture) {
      let next = reflectionTarget;
      if (texture) {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        texture.colorSpace = THREE.LinearSRGBColorSpace;
        const generator = new THREE.PMREMGenerator(renderer);
        try { next = generator.fromEquirectangular(texture); }
        finally { generator.dispose(); }
      }
      for (const material of materials.values()) material.envMap = next.texture;
      if (currentReflectionTarget !== reflectionTarget) currentReflectionTarget.dispose();
      currentReflectionTarget = next;
    },
    setReflectionStrength(value) {
      for (const material of materials.values()) material.envMapIntensity = value;
    },
    setReflectionRotation(radians) {
      for (const material of materials.values()) material.envMapRotation.y = radians;
    },
    dispose() {
      const geometries = new Set();
      const allMaterials = new Set();
      const textures = new Set();
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        geometries.add(o.geometry);
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) allMaterials.add(m);
      });
      for (const m of materials.keys()) allMaterials.add(m);
      for (const m of allMaterials) {
        // envMap is a PMREM this loader or the game owns, never one of the model's own textures.
        for (const [k, v] of Object.entries(m)) if (v?.isTexture && k !== 'envMap') textures.add(v);
        m.dispose();
      }
      for (const g of geometries) g.dispose();
      for (const t of textures) t.dispose();
      lightmap.dispose();
      reflectionTarget.dispose();
      if (currentReflectionTarget !== reflectionTarget) currentReflectionTarget.dispose();
    },
  };
}
