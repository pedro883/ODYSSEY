/**
 * Modelo da nave.
 *
 * Usa o `craft_speederA` do Kenney Space Kit quando disponível, e cai nas
 * primitivas originais quando não (repositório sem `npm run assets`).
 *
 * CONVENÇÃO CRÍTICA: a nave aponta para **-Z**, igual às câmeras do Three.js.
 * `ShipController._getForward()` depende disso. Os modelos do Kenney apontam
 * para +Z, e a correção é aplicada AQUI, na importação — nunca no controlador,
 * senão trocar de modelo vira uma caça ao bug dentro da física de voo.
 *
 * Independente da origem do visual, o resto do jogo só depende de
 * `ship.group`, `ship.setThrust()` e `ship.dispose()`.
 */

import * as THREE from 'three';
import { assets } from '../assets/AssetLibrary.js';
import { SHIP_MODEL } from '../assets/manifest.js';

const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();

/**
 * Prepara o modelo carregado: escala para o tamanho de jogo, centra e corrige
 * a orientação. Devolve null se o asset não existir.
 */
function buildModelHull() {
  const scene = assets.getSceneSync(SHIP_MODEL.path);
  if (!scene) return null;

  const hull = scene.clone(true);
  hull.rotation.y = SHIP_MODEL.yaw;
  hull.updateMatrixWorld(true);

  _box.setFromObject(hull);
  _box.getSize(_size);
  _box.getCenter(_center);

  const escala = SHIP_MODEL.size / (Math.max(_size.x, _size.y, _size.z) || 1);
  hull.scale.setScalar(escala);
  // Centraliza no pivô: o modelo do Kenney tem a origem no chão, e uma nave
  // girando em torno da barriga em vez do centro parece quebrada.
  hull.position.set(-_center.x * escala, -_center.y * escala, -_center.z * escala);

  const wrapper = new THREE.Group();
  wrapper.add(hull);
  return wrapper;
}

export function createShip() {
  const group = new THREE.Group();
  const modelHull = buildModelHull();

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

  // --- Casco --------------------------------------------------------------
  if (modelHull) {
    group.add(modelHull);
  } else {
    // Fallback: a nave original feita de primitivas.
    const fuselage = new THREE.Mesh(new THREE.ConeGeometry(0.62, 3.4, 10), hullMaterial);
    fuselage.rotation.x = -Math.PI / 2; // cone nasce apontando +Y; giramos para -Z
    fuselage.position.z = -0.3;
    group.add(fuselage);

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

    const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12), glassMaterial);
    cockpit.scale.set(1, 0.72, 1.5);
    cockpit.position.set(0, 0.28, -0.55);
    group.add(cockpit);
  }

  // --- Motores ------------------------------------------------------------
  // Continuam sendo primitivas mesmo com o modelo real: são efeito, não casco,
  // e precisam responder ao acelerador. As posições saem do tamanho declarado
  // da nave para acompanharem qualquer modelo que se coloque no manifesto.
  const engineGlows = [];
  const traseira = modelHull ? SHIP_MODEL.size * 0.42 : 1.76;
  const lateral = modelHull ? SHIP_MODEL.size * 0.16 : 0.75;
  const raioMotor = modelHull ? SHIP_MODEL.size * 0.075 : 0.24;
  const glowGeometry = new THREE.CircleGeometry(raioMotor, 12);

  for (const side of [-1, 1]) {
    if (!modelHull) {
      const nacelle = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 1.2, 10), accentMaterial);
      nacelle.rotation.x = Math.PI / 2;
      nacelle.position.set(side * 0.75, -0.1, 1.15);
      group.add(nacelle);
    }

    const glow = new THREE.Mesh(glowGeometry, engineMaterial.clone());
    glow.position.set(side * lateral, -0.1, traseira);
    // O disco olha para +Z (para trás da nave), então fica visível de quem
    // está atrás — que é exatamente onde a câmera de 3ª pessoa vive.
    group.add(glow);
    engineGlows.push(glow);
  }

  const thrustLight = new THREE.PointLight(0x4fd8ff, 0, 14);
  thrustLight.position.set(0, 0, 2.0);
  group.add(thrustLight);

  // Percorrido no fim, e não peça por peça: o casco pode vir de um modelo
  // carregado (`modelHull`), cuja hierarquia interna não conhecemos aqui. A
  // sombra da nave pousada no chão é a única pista visual de que ela está
  // APOIADA e não flutuando um metro acima do terreno.
  group.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  // O disco de propulsão é aditivo e sem profundidade: como projetor ele viraria
  // um retângulo opaco no chão atrás da nave.
  for (const glow of engineGlows) glow.castShadow = false;

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
