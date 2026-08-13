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
import { assets } from '../assets/AssetLibrary.js';
import { propModelsFor } from '../assets/manifest.js';
import { treeVariantsFor } from '../assets/TreeFactory.js';
import { applyWind } from '../shaders/WindShader.js';

/** Campos por instância no buffer vindo do worker. */
export const PROP_STRIDE = 8;

/**
 * Teto por (tipo, variante). Antes era um número só; as árvores procedurais
 * obrigaram a separar por tipo.
 *
 * Um arbusto do Kenney tem ~60 triângulos, uma árvore do EZ-Tree tem ~800.
 * Com o mesmo teto de 3000, a vegetação sozinha pediria 7 milhões de
 * triângulos por frame — mais que o planeta inteiro, e num alvo que é uma
 * Intel Iris Xe integrada (ver "Números medidos" no README).
 *
 * O teto das árvores é o orçamento de triângulos escrito de outro jeito:
 * 3 variantes × 300 × ~800 ≈ 720 k, o que dobra o total do projeto (365 k
 * antes das nuvens e das árvores) sem multiplicá-lo. **É o primeiro número a
 * subir** em quem tem GPU dedicada: 600 ainda roda folgado numa placa de
 * 2020 em diante.
 *
 * Medido no meio de uma floresta (seed 12345, planeta 3): a demanda passa de
 * 4600 árvores, então o teto CORTA muito. É por isso que o repack percorre os
 * chunks do mais perto para o mais longe — o que fica de fora é o horizonte,
 * não o que está ao lado do jogador.
 */
const MAX_INSTANCES = [3000, 300, 3000, 1500];

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
 * Geometrias de emergência, usadas quando o modelo .glb correspondente não
 * está disponível (repositório clonado sem rodar `npm run assets`).
 *
 * São as primitivas originais do projeto. Feias, mas garantem que o jogo nunca
 * fique invisível por falta de arte — e servem de referência de escala: todas
 * têm a BASE na origem e altura ~1, exatamente a convenção para a qual o
 * `AssetLibrary` normaliza os modelos reais.
 */
const FALLBACKS = [
  () => {
    const g = new THREE.IcosahedronGeometry(0.5, 0);
    g.translate(0, 0.5, 0);
    return g;
  },
  () => {
    const g = new THREE.ConeGeometry(0.3, 1, 6);
    g.translate(0, 0.5, 0);
    return g;
  },
  () => {
    const g = new THREE.DodecahedronGeometry(0.5, 0);
    g.scale(1, 0.72, 1);
    g.translate(0, 0.36, 0);
    return g;
  },
  () => {
    const g = new THREE.OctahedronGeometry(0.4, 0);
    g.scale(1, 1.3, 1);
    g.translate(0, 0.52, 0);
    return g;
  },
];

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

    const { palette, foliage } = planet.config;

    // Rochas clareadas em relação à paleta do terreno: a cor de `rock` foi
    // escolhida para encostas vistas de longe, e um pedregulho com aquele
    // valor vira uma silhueta preta ao nível dos olhos.
    const rockColor = new THREE.Color().fromArray(palette.rock).multiplyScalar(2.1).addScalar(0.03);

    this.depositResource = RESOURCES[planet.config.depositResource];
    const depositColor = new THREE.Color(this.depositResource.cor);

    /** @type {THREE.Material[]} materiais deste planeta, descartados em `dispose()` */
    this.materials = [];

    /**
     * `[tipo][variante] = { parts: [...] }`, e cada parte é uma
     * `InstancedMesh` com a própria geometria, o próprio material e a própria
     * cor-base.
     *
     * ---------------------------------------------------------------------
     * POR QUE UMA VARIANTE PODE TER MAIS DE UMA PARTE
     * ---------------------------------------------------------------------
     * Uma árvore procedural é tronco MAIS copa: geometrias distintas, texturas
     * distintas e — o ponto principal — cores distintas. Antes tudo era uma
     * malha só com um material só, e é por isso que a floresta inteira saía
     * verde: não havia onde pintar a casca de marrom.
     *
     * As partes compartilham as MESMAS matrizes de instância; o repack escreve
     * a mesma matriz em todas elas. Isso mantém tronco e copa coladas sem
     * nenhuma hierarquia de cena, que instancing não suporta.
     * @type {{parts: {mesh: THREE.InstancedMesh, h: number, s: number, l: number, jitter: number[]}[]}[][]}
     */
    this.variants = [];

    const modelsByType = propModelsFor(planet.config.type);

    /**
     * Fábrica de parte. `base` é a cor NEUTRA da parte; a cor real de cada
     * instância entra por `instanceColor` no repack.
     *
     * Note que o material nasce BRANCO. É deliberado: `instanceColor` é
     * multiplicado pela cor do material, então deixar a cor no material
     * limitaria a variação a "mais claro ou mais escuro que este verde".
     * Com o material branco, a cor por instância é absoluta e pode passear
     * pelo matiz — que é o que separa uma floresta de um adesivo verde.
     */
    const makePart = (type, geometry, options, base, jitter) => {
      // `wind` é parâmetro nosso, não do Three: passá-lo adiante faria o
      // material avisar no console a cada criação.
      const { wind, map, ...materialOptions } = options;
      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: map ?? null,
        ...materialOptions,
      });
      if (wind) applyWind(material, wind[0], wind[1]);
      this.materials.push(material);

      const mesh = new THREE.InstancedMesh(geometry, material, MAX_INSTANCES[type]);
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // As instâncias cobrem toda a superfície visível ao redor do jogador;
      // uma esfera envolvente global não descartaria nada e ainda custaria
      // um teste por frame.
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      this.group.add(mesh);

      const hsl = { h: 0, s: 0, l: 0 };
      base.getHSL(hsl, THREE.SRGBColorSpace);
      return { mesh, h: hsl.h, s: hsl.s, l: hsl.l, jitter };
    };

    /** Cor de folhagem da variante `index` de `count`, espalhada no matiz. */
    const foliageColor = (index, count) => {
      const offset = count > 1 ? (index / (count - 1) - 0.5) * foliage.spread : 0;
      return new THREE.Color().setHSL(
        (foliage.hue + offset + 1) % 1,
        foliage.saturation,
        foliage.lightness,
        THREE.SRGBColorSpace
      );
    };

    // Variação por INSTÂNCIA, em [matiz, saturação, luminosidade]. A folhagem
    // é a única que mexe no matiz de verdade: é o que produz aquela árvore
    // amarelada no meio das verdes, sem a qual a floresta parece impressa.
    const FOLIAGE_JITTER = [foliage.spread * 0.6, 0.30, 0.34];
    const MINERAL_JITTER = [0.02, 0.20, 0.32];

    for (let type = 0; type < PROP_COUNT; type++) {
      if (type === PROP_TYPE.TREE && !modelsByType[type]?.length) {
        // Linha de árvore vazia no manifesto = árvore procedural, gerada pelo
        // EZ-Tree a partir do seed do planeta. Ver `assets/TreeFactory.js`.
        // (Mundos exóticos declaram cogumelos e caem no caminho comum abaixo.)
        const trees = treeVariantsFor(planet.config.type, planet.config.seed);
        this.variants.push(
          trees.map((tree, index) => ({
            parts: [
              makePart(
                type,
                tree.bark,
                { map: tree.barkMap, roughness: 0.95, wind: [0.018, 0.8] },
                new THREE.Color().fromArray(foliage.bark),
                // A casca varia pouco no matiz e bastante no valor: é o que dá
                // troncos mais claros e mais escuros sem virar madeira colorida.
                [0.015, 0.18, 0.30]
              ),
              makePart(
                type,
                tree.leaves,
                {
                  map: tree.leafMap,
                  // `alphaTest` e não `transparent`: folha transparente exigiria
                  // ordenação por profundidade entre instâncias, que instancing
                  // não faz. Com corte de alfa a copa é opaca, escreve no depth
                  // buffer e se resolve sozinha.
                  alphaTest: 0.45,
                  side: THREE.DoubleSide,
                  roughness: 0.85,
                  wind: [0.06, 1.0],
                },
                foliageColor(index, trees.length),
                FOLIAGE_JITTER
              ),
            ],
          }))
        );
        continue;
      }

      // `null` = sem modelo declarado: cai na primitiva de fallback. Sempre ao
      // menos uma variante, para o tipo nunca desaparecer do jogo.
      const paths = modelsByType[type]?.length ? modelsByType[type] : [null];

      this.variants.push(
        paths.map((path, index) => {
          const geometry = path
            ? assets.getGeometrySync(path, FALLBACKS[type])
            : FALLBACKS[type]();
          // A textura do modelo, quando existe, entra como `map` e multiplica a
          // cor por instância: ganhamos o detalhe do modelo E a identidade
          // cromática de cada mundo.
          const map = path ? assets.textureFor(path) : null;

          if (type === PROP_TYPE.BUSH || type === PROP_TYPE.TREE) {
            // Um arbusto chacoalha; um cogumelo de 4 metros apenas oscila.
            const wind = type === PROP_TYPE.BUSH ? [0.07, 1.35] : [0.03, 0.7];
            return {
              parts: [
                makePart(
                  type,
                  geometry,
                  { map, roughness: 0.9, wind },
                  foliageColor(index, paths.length),
                  FOLIAGE_JITTER
                ),
              ],
            };
          }

          if (type === PROP_TYPE.ROCK) {
            return {
              parts: [makePart(type, geometry, { map, roughness: 1.0 }, rockColor, MINERAL_JITTER)],
            };
          }

          return {
            parts: [
              makePart(
                type,
                geometry,
                {
                  map,
                  roughness: 0.25,
                  metalness: 0.1,
                  // Depósitos brilham para serem localizáveis à distância — é o
                  // que os torna um objetivo de exploração e não só mais uma
                  // pedra. O emissivo NÃO é afetado por `instanceColor`, então
                  // o brilho continua idêntico em todos eles, que é o certo:
                  // é ele que o jogador aprende a reconhecer no horizonte.
                  emissive: depositColor,
                  emissiveIntensity: 0.55,
                },
                depositColor,
                [0.01, 0.10, 0.16]
              ),
            ],
          };
        })
      );
    }
  }

  get instanceCount() {
    let total = 0;
    for (const row of this.variants) for (const v of row) total += v.parts[0].mesh.count;
    return total;
  }

  /** Número de draw calls que a vegetação adiciona. */
  get drawCalls() {
    let total = 0;
    for (const row of this.variants) {
      for (const v of row) for (const part of v.parts) if (part.mesh.count > 0) total++;
    }
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

  /**
   * Reempacota os buffers de instância se algo mudou.
   * @param {THREE.Vector3} [cameraLocal] câmera em espaço local do planeta
   */
  update(cameraLocal) {
    if (!this.dirty) return;
    this.dirty = false;

    const counts = this.variants.map((row) => new Array(row.length).fill(0));

    // ---------------------------------------------------------------------
    // DO MAIS PERTO PARA O MAIS LONGE.
    //
    // Numa floresta densa a demanda por árvores passa de 2800 e o teto de
    // instâncias corta boa parte. O que decide QUEM é cortado é a ordem deste
    // laço — e a ordem natural do Map é a de chegada dos chunks, ou seja,
    // arbitrária. O efeito era o pior possível: árvores sumindo a dez passos
    // do jogador enquanto outras, no horizonte, continuavam desenhadas.
    //
    // Ordenar pelo centro do chunk (233 deles, não os milhares de props)
    // custa microssegundos num repack que já é raro, e transforma o teto num
    // raio de visão em vez de um sorteio.
    // ---------------------------------------------------------------------
    const visible = [];
    for (const chunk of this.chunks.values()) if (chunk.visible) visible.push(chunk);
    if (cameraLocal) {
      for (const chunk of visible) chunk._distance = chunk.center.distanceToSquared(cameraLocal);
      visible.sort((a, b) => a._distance - b._distance);
    }

    for (const chunk of visible) {
      const { data, center, collected } = chunk;
      const count = data.length / PROP_STRIDE;

      for (let i = 0; i < count; i++) {
        if (collected.has(i)) continue;

        const o = i * PROP_STRIDE;
        const type = data[o + 5] | 0;
        const row = this.variants[type];
        if (!row) continue;

        const tintField = data[o + 6];

        // A variante sai do MESMO campo aleatório que já servia de matiz.
        // Reaproveitá-lo evita mudar o protocolo e o stride do worker — o
        // valor é determinístico por prop, então a planta que nasceu carvalho
        // continua carvalho ao recarregar o chunk.
        const variant = row.length === 1 ? 0 : Math.min(row.length - 1, (tintField * row.length) | 0);
        const parts = row[variant].parts;
        const slot = counts[type][variant];
        if (slot >= MAX_INSTANCES[type]) continue;

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

        // Dois pseudo-aleatórios independentes a partir do ÚNICO campo que o
        // worker manda. A parte inteira de `tintField * nVariantes` já virou o
        // índice da variante, então aqui usamos a fracionária e um segundo
        // embaralhamento dela — o suficiente para matiz e brilho não andarem
        // juntos (e traírem a correlação como um degradê).
        const r1 = (tintField * row.length) % 1;
        const r2 = (r1 * 7.13 + data[o + 4] * 0.159) % 1;

        for (const part of parts) {
          part.mesh.setMatrixAt(slot, _matrix);

          // Variação por instância em HSL. Antes era só um multiplicador de
          // brilho cinza, e um campo inteiro de arbustos saía como uma mancha
          // chapada da mesma cor, mais clara aqui e mais escura ali.
          const [jh, js, jl] = part.jitter;
          _color.setHSL(
            (part.h + (r1 - 0.5) * jh + 1) % 1,
            THREE.MathUtils.clamp(part.s * (1 + (r2 - 0.5) * js), 0, 1),
            THREE.MathUtils.clamp(part.l * (1 + (r1 * 0.35 + r2 * 0.65 - 0.5) * jl), 0.02, 0.98),
            THREE.SRGBColorSpace
          );
          part.mesh.setColorAt(slot, _color);
        }

        counts[type][variant] = slot + 1;
      }
    }

    for (let type = 0; type < PROP_COUNT; type++) {
      const row = this.variants[type];
      for (let v = 0; v < row.length; v++) {
        for (const part of row[v].parts) {
          part.mesh.count = counts[type][v];
          part.mesh.instanceMatrix.needsUpdate = true;
          if (part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true;
        }
      }
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
    for (const row of this.variants) {
      for (const variant of row) {
        // A geometria pode vir do cache compartilhado (AssetLibrary para os
        // .glb, TreeFactory para as árvores) e ser usada por outros planetas —
        // quem descarta é a biblioteca, não aqui.
        for (const part of variant.parts) part.mesh.removeFromParent();
      }
    }
    // O material é criado por planeta (cor da folhagem), então este é nosso. A
    // textura NÃO: ela é compartilhada entre planetas.
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
    this.variants.length = 0;
    this.chunks.clear();
  }
}

export { PROP_TYPE };
