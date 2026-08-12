/**
 * Modelo da nave, montado a partir de primitivas.
 *
 * Fica de propósito em geometria simples: o objetivo da PoC é o pipeline
 * procedural, não o asset. Para trocar por um modelo real, substitua o
 * conteúdo de `createShip()` por um `GLTFLoader` — o resto do código só
 * depende de `ship.group` (um Object3D) e de `ship.setThrust()`.
 *
 * Convenção: a nave aponta para -Z, que é a mesma direção "para frente" das
 * câmeras do Three.js. Isso deixa `getWorldDirection()` utilizável direto.
 */

import * as THREE from 'three';

export function createShip() {
  const group = new THREE.Group();

  const hullMaterial = new THREE.MeshStandardMaterial({
    color: 0xb8c4cf,
    metalness: 0.85,
    roughness: 0.35,
  });

  const accentMaterial = new THREE.MeshStandardMaterial({
    color: 0x1f2a33,
    metalness: 0.6,
    roughness: 0.5,
  });

  const glassMaterial = new THREE.MeshStandardMaterial({
    color: 0x0a2430,
    metalness: 0.2,
    roughness: 0.05,
    emissive: 0x0b3a4a,
    emissiveIntensity: 0.6,
  });

  const engineMaterial = new THREE.MeshBasicMaterial({
    color: 0x4fd8ff,
    transparent: true,
    opacity: 0.95,
    fog: false,
  });

  // --- Fuselagem ----------------------------------------------------------
  const fuselage = new THREE.Mesh(new THREE.ConeGeometry(0.62, 3.4, 10), hullMaterial);
  fuselage.rotation.x = -Math.PI / 2; // cone nasce apontando +Y; giramos para -Z
  fuselage.position.z = -0.3;
  group.add(fuselage);

  // --- Asas ---------------------------------------------------------------
  const wingGeometry = new THREE.BoxGeometry(2.4, 0.09, 1.05);
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(wingGeometry, hullMaterial);
    wing.position.set(side * 1.35, -0.05, 0.55);
    wing.rotation.z = side * 0.14; // leve diedro
    wing.rotation.y = side * -0.18; // enflechamento
    group.add(wing);

    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.5, 0.7), accentMaterial);
    tip.position.set(side * 2.45, 0.16, 0.65);
    group.add(tip);
  }

  // --- Cockpit ------------------------------------------------------------
  const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12), glassMaterial);
  cockpit.scale.set(1, 0.72, 1.5);
  cockpit.position.set(0, 0.28, -0.55);
  group.add(cockpit);

  // --- Motores ------------------------------------------------------------
  const engineGlows = [];
  const nacelleGeometry = new THREE.CylinderGeometry(0.26, 0.3, 1.2, 10);
  const glowGeometry = new THREE.CircleGeometry(0.24, 12);

  for (const side of [-1, 1]) {
    const nacelle = new THREE.Mesh(nacelleGeometry, accentMaterial);
    nacelle.rotation.x = Math.PI / 2;
    nacelle.position.set(side * 0.75, -0.1, 1.15);
    group.add(nacelle);

    const glow = new THREE.Mesh(glowGeometry, engineMaterial.clone());
    glow.position.set(side * 0.75, -0.1, 1.76);
    // O disco olha para +Z (para trás da nave), então fica visível de quem
    // está atrás — que é exatamente onde a câmera de 3ª pessoa vive.
    group.add(glow);
    engineGlows.push(glow);
  }

  const thrustLight = new THREE.PointLight(0x4fd8ff, 0, 14);
  thrustLight.position.set(0, 0, 2.0);
  group.add(thrustLight);

  return {
    group,

    /**
     * Reflete o empuxo atual no visual dos motores.
     * @param {number} amount 0..1 (já contando o booster)
     */
    setThrust(amount) {
      const t = Math.min(1, Math.max(0, amount));
      for (const glow of engineGlows) {
        glow.material.opacity = 0.25 + t * 0.75;
        glow.scale.setScalar(0.6 + t * 0.9);
      }
      thrustLight.intensity = t * 9;
    },

    dispose() {
      group.traverse((object) => {
        if (object.isMesh) {
          object.geometry.dispose();
          object.material.dispose();
        }
      });
    },
  };
}
