/**
 * Vegetação, rochas e depósitos com `InstancedMesh`.
 *
 * POR QUE INSTANCING: um planeta povoado tem milhares de arbustos visíveis.
 * Como `Mesh` individuais seriam milhares de draw calls e o FPS morreria antes
 * de qualquer coisa aparecer. Como `InstancedMesh`, cada TIPO custa **uma**
 * draw call, independente de haver 10 ou 8000 instâncias.
 *
 * ESTRATÉGIA DE ATUALIZAÇÃO: em vez de um alocador de blocos livres (que
 * fragmenta e complica), reempacotamos o buffer inteiro quando o conjunto de
 * chunks com props muda. Isso só acontece quando o jogador cruza a fronteira
 * de um chunk fino — raro, especialmente a pé — e custa ~1 ms. Um alocador
 * incremental seria mais rápido no pior caso e muito mais fácil de errar.
 *
 * Props só existem nos 2 níveis de LOD mais finos: instanciar vegetação num
 * chunk de nível 3 seria desperdiçar milhões de instâncias sub-pixel.
 */

import * as THREE from 'three';
import { PROP_TYPE, PROP_COUNT, RESOURCES } from '../shared/props.js';

/** Campos por instância no buffer vindo do worker. */
export const PROP_STRIDE = 8;

const MAX_INSTANCES = 8000;

const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _yawQuat = new THREE.Quaternion();
const _color = new THREE.Color();
const _up = new THREE.Vector3();
const _world = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * Geometrias com a BASE na origem (não o centro): assim `position` é o ponto
 * de contato com o solo e a prop não fica meio enterrada.
 */
function buildGeometries() {
  const bush = new THREE.IcosahedronGeometry(0.6, 0);
  bush.scale(1, 1.25, 1);
  bush.translate(0, 0.7, 0);

  const tree = new THREE.ConeGeometry(0.85, 3.0, 6);
  tree.translate(0, 1.5, 0);

  const rock = new THREE.DodecahedronGeometry(0.7, 0);
  rock.scale(1, 0.72, 1);
  rock.translate(0, 0.4, 0);

  const deposit = new THREE.OctahedronGeometry(0.62, 0);
  deposit.scale(1, 1.6, 1);
  deposit.translate(0, 0.9, 0);

  return [bush, tree, rock, deposit];
}

export class PropScatter {
  /**
   * @param {import('./Planet.js').Planet} planet
   * @param {THREE.Object3D} group nó da cena (espaço local do planeta)
   */
  constructor(planet, group) {
    this.planet = planet;
    this.group = group;

    /** @type {Map<string, {data: Float32Array, center: THREE.Vector3, collected: Set<number>}>} */
    this.chunks = new Map();

    /**
     * O que já foi coletado, por chunk — SOBREVIVE ao descarregamento.
     *
     * Sem isso, afastar-se e voltar faria o arbusto que você acabou de colher
     * reaparecer. Guardamos só índices de props colhidos, então o custo é
     * proporcional ao que o jogador realmente coletou, não ao tamanho do mundo.
     * @type {Map<string, Set<number>>}
     */
    this.harvested = new Map();
    this.dirty = false;

    const palette = planet.config.palette;
    const vegetation = new THREE.Color().fromArray(palette.grass).multiplyScalar(1.35);
    // Rochas clareadas em relação à paleta do terreno: a cor de `rock` foi
    // escolhida para encostas vistas de longe, e um pedregulho com aquele
    // valor vira uma silhueta preta ao nível dos olhos.
    const rockColor = new THREE.Color().fromArray(palette.rock).multiplyScalar(2.1).addScalar(0.03);

    this.depositResource = RESOURCES[planet.config.depositResource];
    const depositColor = new THREE.Color(this.depositResource.cor);

    const geometries = buildGeometries();
    const materials = [
      new THREE.MeshStandardMaterial({ color: vegetation, roughness: 0.9, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: vegetation, roughness: 0.88, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: rockColor, roughness: 1.0, flatShading: true }),
      new THREE.MeshStandardMaterial({
        color: depositColor,
        roughness: 0.25,
        metalness: 0.1,
        flatShading: true,
        // Depósitos brilham para serem localizáveis à distância — é o que os
        // torna um objetivo de exploração e não só mais uma pedra.
        emissive: depositColor,
        emissiveIntensity: 0.55,
      }),
    ];

    /** @type {THREE.InstancedMesh[]} */
    this.meshes = [];
    for (let type = 0; type < PROP_COUNT; type++) {
      const mesh = new THREE.InstancedMesh(geometries[type], materials[type], MAX_INSTANCES);
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // As instâncias cobrem toda a superfície visível ao redor do jogador;
      // uma esfera envolvente global não descartaria nada e ainda custaria
      // um teste por frame.
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
  }

  get instanceCount() {
    let total = 0;
    for (const mesh of this.meshes) total += mesh.count;
    return total;
  }

  /**
   * @param {string} key chave estável do chunk (ver `chunkKey()`)
   * @param {Float32Array} data buffer devolvido pelo worker
   * @param {number[]} center centro do chunk em espaço local do planeta
   */
  addChunk(key, data, center) {
    if (!data || data.length === 0) return;

    let collected = this.harvested.get(key);
    if (!collected) {
      collected = new Set();
      this.harvested.set(key, collected);
    }

    this.chunks.set(key, {
      data,
      center: new THREE.Vector3().fromArray(center),
      collected,
      visible: false,
    });
    this.dirty = true;
  }

  removeChunk(key) {
    if (this.chunks.delete(key)) this.dirty = true;
  }

  /**
   * Acompanha a visibilidade do chunk de terreno correspondente.
   *
   * Sem isso a vegetação DUPLICA: um chunk de nível 8 que já foi dividido
   * continua carregado (só escondido, enquanto os 4 filhos desenham), e seus
   * props continuariam na malha instanciada por cima dos props dos filhos —
   * dois arbustos no mesmo lugar, com z-fighting entre eles.
   */
  setVisible(key, visible) {
    const chunk = this.chunks.get(key);
    if (!chunk || chunk.visible === visible) return;
    chunk.visible = visible;
    this.dirty = true;
  }

  /** Reempacota os buffers de instância se algo mudou. */
  update() {
    if (!this.dirty) return;
    this.dirty = false;

    const counts = new Array(PROP_COUNT).fill(0);

    for (const chunk of this.chunks.values()) {
      if (!chunk.visible) continue;

      const { data, center, collected } = chunk;
      const count = data.length / PROP_STRIDE;

      for (let i = 0; i < count; i++) {
        if (collected.has(i)) continue;

        const o = i * PROP_STRIDE;
        const type = data[o + 5] | 0;
        const slot = counts[type];
        if (slot >= MAX_INSTANCES) continue;

        _position.set(data[o] + center.x, data[o + 1] + center.y, data[o + 2] + center.z);

        // "Para cima" é radial: a prop precisa ficar perpendicular à
        // superfície da esfera, não ao eixo Y global.
        _up.copy(_position).normalize();
        _quaternion.setFromUnitVectors(Y_AXIS, _up);
        _yawQuat.setFromAxisAngle(Y_AXIS, data[o + 4]);
        _quaternion.multiply(_yawQuat);

        const s = data[o + 3];
        _scale.set(s, s, s);
        _matrix.compose(_position, _quaternion, _scale);
        this.meshes[type].setMatrixAt(slot, _matrix);

        // Variação de tom por instância: sem isso um campo de arbustos vira
        // uma mancha chapada de cor única.
        const tint = 0.75 + data[o + 6] * 0.5;
        _color.setRGB(tint, tint, tint);
        this.meshes[type].setColorAt(slot, _color);

        counts[type] = slot + 1;
      }
    }

    for (let type = 0; type < PROP_COUNT; type++) {
      const mesh = this.meshes[type];
      mesh.count = counts[type];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * Prop coletável mais próximo de um ponto do mundo.
   *
   * Faz uma varredura linear, mas filtrando chunks pelo centro primeiro: só
   * alguns dos ~50 chunks com props ficam dentro do alcance, então o laço
   * interno quase nunca roda.
   *
   * @param {THREE.Vector3} worldPoint
   * @param {number} radius
   * @returns {{key:string, index:number, type:number, position:THREE.Vector3, distance:number}|null}
   */
  findNearest(worldPoint, radius) {
    const origin = this.planet.group.position;
    let best = null;
    let bestDistSq = radius * radius;

    for (const [key, chunk] of this.chunks) {
      if (!chunk.visible) continue; // não se minera o que não está desenhado

      // Rejeição grosseira: centro do chunk longe demais para conter algo.
      _world.copy(chunk.center).add(origin);
      const chunkReach = radius + this.planet.config.radius * 0.02;
      if (_world.distanceToSquared(worldPoint) > chunkReach * chunkReach) continue;

      const { data, center, collected } = chunk;
      const count = data.length / PROP_STRIDE;

      for (let i = 0; i < count; i++) {
        if (collected.has(i)) continue;
        const o = i * PROP_STRIDE;
        _world.set(
          data[o] + center.x + origin.x,
          data[o + 1] + center.y + origin.y,
          data[o + 2] + center.z + origin.z
        );
        const d2 = _world.distanceToSquared(worldPoint);
        if (d2 < bestDistSq) {
          bestDistSq = d2;
          best = {
            key,
            index: i,
            type: data[o + 5] | 0,
            position: _world.clone(),
            distance: Math.sqrt(d2),
          };
        }
      }
    }
    return best;
  }

  /** Remove um prop coletado (some da malha no próximo `update()`). */
  collect(key, index) {
    const chunk = this.chunks.get(key);
    if (!chunk || chunk.collected.has(index)) return false;
    chunk.collected.add(index); // é o MESMO Set guardado em `harvested`
    this.dirty = true;
    return true;
  }

  /** Contagem por tipo dentro de um raio — usado pelo scanner. */
  census(worldPoint, radius) {
    const counts = new Array(PROP_COUNT).fill(0);
    const origin = this.planet.group.position;
    const radiusSq = radius * radius;

    for (const chunk of this.chunks.values()) {
      if (!chunk.visible) continue;

      const { data, center, collected } = chunk;
      const count = data.length / PROP_STRIDE;
      for (let i = 0; i < count; i++) {
        if (collected.has(i)) continue;
        const o = i * PROP_STRIDE;
        _world.set(
          data[o] + center.x + origin.x,
          data[o + 1] + center.y + origin.y,
          data[o + 2] + center.z + origin.z
        );
        if (_world.distanceToSquared(worldPoint) <= radiusSq) counts[data[o + 5] | 0]++;
      }
    }
    return counts;
  }

  dispose() {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.material.dispose();
      mesh.removeFromParent();
    }
    this.meshes.length = 0;
    this.chunks.clear();
  }
}

export { PROP_TYPE };
