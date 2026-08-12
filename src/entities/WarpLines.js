/**
 * Riscos de velocidade do pulse drive.
 *
 * Sem referência visual, viajar a 26 000 u/s no vácuo parece estar parado: não
 * há nada perto o bastante para produzir paralaxe. Estes riscos são partículas
 * mantidas dentro de uma caixa ao redor da câmera e esticadas na direção do
 * movimento — dão a sensação de velocidade que a cena, sozinha, não tem.
 *
 * Custo fixo: 1 draw call, 600 segmentos, sem alocação por frame.
 */

import * as THREE from 'three';

const COUNT = 600;
const BOX = 260; // meia-aresta da caixa que segue a câmera

const _forward = new THREE.Vector3();
const _offset = new THREE.Vector3();

export class WarpLines {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    const positions = new Float32Array(COUNT * 2 * 3); // 2 vértices por risco
    this.seeds = new Float32Array(COUNT * 3);

    for (let i = 0; i < COUNT; i++) {
      this.seeds[i * 3] = (Math.random() * 2 - 1) * BOX;
      this.seeds[i * 3 + 1] = (Math.random() * 2 - 1) * BOX;
      this.seeds[i * 3 + 2] = (Math.random() * 2 - 1) * BOX;
    }

    const geometry = new THREE.BufferGeometry();
    this.positionAttribute = new THREE.BufferAttribute(positions, 3);
    this.positionAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.positionAttribute);

    this.lines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({
        color: 0xbfe9ff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      })
    );
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    scene.add(this.lines);
  }

  /**
   * @param {THREE.Camera} camera
   * @param {THREE.Vector3} velocity velocidade da nave
   * @param {number} intensity 0..1 (a rampa do pulse)
   */
  update(camera, velocity, intensity) {
    const material = this.lines.material;
    material.opacity = intensity * 0.75;
    this.lines.visible = intensity > 0.01;
    if (!this.lines.visible) return;

    const speed = velocity.length();
    if (speed < 1e-3) return;
    _forward.copy(velocity).divideScalar(speed);

    // Comprimento do risco proporcional à velocidade, com teto para não virar
    // uma parede sólida de linhas.
    const length = Math.min(150, speed * 0.006) * intensity;

    const array = this.positionAttribute.array;
    const origin = camera.position;

    for (let i = 0; i < COUNT; i++) {
      const s = i * 3;

      // Mantém a partícula dentro da caixa que acompanha a câmera: em vez de
      // reposicionar quando sai, "enrolamos" a coordenada com módulo — sem
      // ramificação e sem números aleatórios por frame.
      _offset.set(
        wrap(this.seeds[s] - origin.x, BOX),
        wrap(this.seeds[s + 1] - origin.y, BOX),
        wrap(this.seeds[s + 2] - origin.z, BOX)
      );

      const v = i * 6;
      array[v] = origin.x + _offset.x;
      array[v + 1] = origin.y + _offset.y;
      array[v + 2] = origin.z + _offset.z;
      array[v + 3] = array[v] - _forward.x * length;
      array[v + 4] = array[v + 1] - _forward.y * length;
      array[v + 5] = array[v + 2] - _forward.z * length;
    }

    this.positionAttribute.needsUpdate = true;
  }

  dispose() {
    this.lines.geometry.dispose();
    this.lines.material.dispose();
    this.lines.removeFromParent();
  }
}

/** Mapeia um valor qualquer para [-half, half) de forma contínua. */
function wrap(value, half) {
  const span = half * 2;
  return ((((value + half) % span) + span) % span) - half;
}
