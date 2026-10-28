import * as THREE from 'three';
import { loadCoinPusher } from './loadCoinPusher.js';
import { applyWinterLook } from './winterLook.js';
import { sceneSettings } from './sceneSettings.js';

// The delivered entry point, minus its renderQuality module: the game has its own quality profile,
// and both of the delivery's profiles load the same 512 lightmap anyway.
export async function loadConfiguredCoinPusher(renderer, scene, { baseURL }) {
  const model = await loadCoinPusher(renderer, {
    baseURL,
    lightmapFile: 'coin_pusher_lightmap_512.exr',
    reflectionFile: `hdri/${sceneSettings.reflection.file}`,
  });
  try {
    applyWinterLook(renderer, scene, model.scene);
    scene.fog.color.set(sceneSettings.fog.color);
    scene.fog.density = sceneSettings.fog.enabled ? sceneSettings.fog.density : 0;
    model.setReflectionStrength(sceneSettings.reflection.strength);
    model.setReflectionRotation(THREE.MathUtils.degToRad(sceneSettings.reflection.rotationDegrees));
    scene.add(model.scene);
    return { ...model, settings: sceneSettings };
  } catch (error) {
    model.dispose();
    throw error;
  }
}
