import * as THREE from 'three';

// A single-pass grade plus depth fog; no extra render targets or transparent layers.
export const winterLook = { exposureEV: 0.08, fogDensity: 0.016, fogColor: '#a2b9cc' };

export function applyWinterLook(renderer, scene, root) {
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 2 ** winterLook.exposureEV;
  scene.fog = new THREE.FogExp2(winterLook.fogColor, winterLook.fogDensity);
  const seen = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (seen.has(m)) continue;
      seen.add(m);
      const previous = m.onBeforeCompile;
      const key = m.customProgramCacheKey();
      m.onBeforeCompile = function (shader, webglRenderer) {
        previous.call(this, shader, webglRenderer);
        shader.fragmentShader = shader.fragmentShader.replace('#include <tonemapping_fragment>', `
          #include <tonemapping_fragment>
          // Grade after AgX in a display-like domain, then restore linear output.
          vec3 winterColor = pow(max(gl_FragColor.rgb, vec3(0.0)), vec3(1.0 / 2.2));
          float winterLuma = dot(winterColor, vec3(0.2126, 0.7152, 0.0722));
          winterColor = mix(vec3(winterLuma), winterColor, 1.08);
          winterColor = (winterColor - 0.45) * 1.09 + 0.45;
          float winterShadow = 1.0 - smoothstep(0.12, 0.58, winterLuma);
          float winterHighlight = smoothstep(0.5, 0.95, winterLuma);
          winterColor += winterShadow * vec3(-0.006, 0.003, 0.014);
          winterColor += winterHighlight * vec3(0.009, 0.006, -0.003);
          gl_FragColor.rgb = pow(clamp(winterColor, 0.0, 1.0), vec3(2.2));
        `);
      };
      m.customProgramCacheKey = () => key + '-winter-grade-v1';
      m.needsUpdate = true;
    }
  });
}
