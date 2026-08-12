/**
 * O "céu" do espaço: campo de estrelas e a estrela do sistema.
 *
 * Tudo aqui é decorativo e de custo fixo — 1 draw call para as estrelas e
 * 1 sprite para o sol. Os planetas NÃO estão aqui: eles são corpos reais,
 * com terreno e LOD, gerenciados por `StarSystem`.
 *
 * Truque central: o grupo de estrelas ACOMPANHA a câmera. Como as estrelas
 * reais estão a anos-luz, elas não devem ter paralaxe; se ficassem fixas na
 * origem, voar 50.000 unidades faria a "esfera celeste" passar por você.
 */

import * as THREE from 'three';
import { mulberry32 } from '../shared/noise.js';

const STAR_SHELL_RADIUS = 90000;

/** Textura procedural de brilho radial — usada no sol e no halo. */
function createGlowTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0.0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.15, 'rgba(255,248,225,0.95)');
  gradient.addColorStop(0.35, 'rgba(255,205,130,0.35)');
  gradient.addColorStop(1.0, 'rgba(255,170,90,0)');

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * @param {THREE.Scene} scene
 * @param {number} seed
 */
export function createStarBackdrop(scene, seed) {
  const rand = mulberry32(seed ^ 0x9e3779b9);

  // ---------------------------------------------------------------------
  // Campo de estrelas
  // ---------------------------------------------------------------------
  const STAR_COUNT = 9000;
  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);
  const color = new THREE.Color();

  for (let i = 0; i < STAR_COUNT; i++) {
    // Distribuição uniforme na esfera. Sortear ângulos direto agruparia
    // estrelas nos polos — este método (z uniforme) não tem esse viés.
    const z = rand() * 2 - 1;
    const theta = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);

    const i3 = i * 3;
    positions[i3] = Math.cos(theta) * r * STAR_SHELL_RADIUS;
    positions[i3 + 1] = z * STAR_SHELL_RADIUS;
    positions[i3 + 2] = Math.sin(theta) * r * STAR_SHELL_RADIUS;

    // Temperatura estelar: a maioria é fria/alaranjada, poucas são azuis.
    const temperature = Math.pow(rand(), 2.2);
    const hue = 0.08 - temperature * 0.06 + (temperature > 0.85 ? 0.55 : 0);
    const brightness = 0.35 + Math.pow(rand(), 3) * 0.65;
    color.setHSL(hue, 0.35, brightness * 0.7, THREE.SRGBColorSpace);
    colors[i3] = color.r; colors[i3 + 1] = color.g; colors[i3 + 2] = color.b;
  }

  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  starGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const starMaterial = new THREE.PointsMaterial({
    size: 2.0,
    // Sem atenuação por distância: a "esfera celeste" é conceitualmente
    // infinita, então o tamanho na tela é constante (em pixels).
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    fog: false,
  });

  const stars = new THREE.Points(starGeometry, starMaterial);
  stars.frustumCulled = false; // segue a câmera; o culling só custaria tempo
  stars.renderOrder = -100;
  scene.add(stars);

  // ---------------------------------------------------------------------
  // Estrela do sistema
  // ---------------------------------------------------------------------
  const sunDirection = new THREE.Vector3(0.6, 0.35, 0.72).normalize();
  const sunDistance = 60000;

  const sunLight = new THREE.DirectionalLight(0xfff2dd, 3.2);
  sunLight.position.copy(sunDirection).multiplyScalar(sunDistance);
  scene.add(sunLight);
  scene.add(sunLight.target); // alvo na origem: a luz aponta para o planeta

  const glowTexture = createGlowTexture();
  const sunSprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // depthTest LIGADO: o planeta precisa eclipsar o sol quando passa na
      // frente. Com o teste desligado o disco solar atravessa o planeta e
      // aparece como um clarão no meio do lado noturno.
      depthTest: true,
      fog: false,
    })
  );
  sunSprite.scale.setScalar(sunDistance * 0.22);
  sunSprite.renderOrder = -50;
  scene.add(sunSprite);

  return {
    sunLight,
    sunDirection,
    stars,
    sunSprite,

    /**
     * @param {THREE.Camera} camera
     * @param {number} elapsed segundos desde o boot
     * @param {number} atmosphereFactor 0 = vácuo, 1 = solo
     */
    update(camera, elapsed, atmosphereFactor) {
      // Ciclo dia/noite: em vez de girar o planeta (o que arrastaria a nave
      // pousada junto), giramos a estrela ao redor dele. Efeito visual idêntico
      // e sem nenhum problema de referencial.
      const angle = elapsed * 0.012;
      sunDirection.set(Math.cos(angle) * 0.94, 0.33, Math.sin(angle) * 0.94).normalize();
      sunLight.position.copy(sunDirection).multiplyScalar(sunDistance);
      sunSprite.position.copy(camera.position).addScaledVector(sunDirection, sunDistance);

      stars.position.copy(camera.position);

      // O céu diurno apaga as estrelas — o mesmo motivo pelo qual não se vê
      // estrela de dia na Terra: o espalhamento atmosférico as ofusca.
      starMaterial.opacity = 1 - atmosphereFactor * 0.98;
      sunSprite.material.opacity = 1 - atmosphereFactor * 0.35;
    },

    dispose() {
      starGeometry.dispose();
      starMaterial.dispose();
      glowTexture.dispose();
      sunSprite.material.dispose();
    },
  };
}
