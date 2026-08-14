/**
 * Ponte entre a quadtree (main thread) e o pool de workers.
 *
 * Responsabilidades:
 *   - manter UM index buffer compartilhado por todos os chunks;
 *   - priorizar a fila: o chunk mais perto da câmera é gerado primeiro;
 *   - limitar o número de jobs em voo (backpressure);
 *   - cancelar pedidos de nós que colapsaram antes da resposta chegar;
 *   - transformar o payload do worker em `THREE.Mesh`;
 *   - manter um cache LRU para o vaivém típico do voo.
 */

import * as THREE from 'three';
import { aplicarDetalheDeSuperficie } from '../shaders/SurfaceDetail.js';

/**
 * Chave estável de um chunk.
 *
 * Usa a identidade GEOMÉTRICA (face + retângulo), não o id do pedido: o mesmo
 * pedaço de terreno precisa achar sua entrada no cache e seus props colhidos
 * mesmo depois de ser descarregado e pedido de novo com outro id.
 */
export function chunkKey(face, u, v, size) {
  return `${face}:${u}:${v}:${size}`;
}

/**
 * Constrói o index buffer de um chunk.
 *
 * Chamado UMA vez por sessão: a topologia é idêntica para todos os chunks
 * (mesma resolução), só as posições mudam. Compartilhar o mesmo
 * `BufferAttribute` entre centenas de geometrias economiza megabytes de VRAM
 * e um upload de índices por chunk.
 *
 * Layout de vértices (precisa bater com `terrain.worker.js`):
 *   [0 .. N*N-1]              grade interior, linha por linha
 *   [N*N     .. N*N+N-1]      saia da borda v=0
 *   [N*N+N   .. N*N+2N-1]     saia da borda v=1
 *   [N*N+2N  .. N*N+3N-1]     saia da borda u=0
 *   [N*N+3N  .. N*N+4N-1]     saia da borda u=1
 */
function buildSharedIndex(res) {
  const N = res + 1;
  const vertexCount = N * N + N * 4;
  const triCount = res * res * 2 + res * 4 * 2;

  const IndexArray = vertexCount > 65535 ? Uint32Array : Uint16Array;
  const idx = new IndexArray(triCount * 3);
  let p = 0;

  // --- Interior. Winding CCW visto de FORA do planeta -----------------------
  // Cada face do cubo usa uma base (u,v,w) dextrógira com w para fora, então
  // cross(du, dv) = w e a ordem (a,b,d)/(a,d,c) é frontal nas 6 faces.
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const a = y * N + x;
      const b = a + 1;
      const c = a + N;
      const d = c + 1;
      idx[p++] = a; idx[p++] = b; idx[p++] = d;
      idx[p++] = a; idx[p++] = d; idx[p++] = c;
    }
  }

  // --- Saias ----------------------------------------------------------------
  // O winding de cada borda é invertido em relação à oposta porque a parede
  // aponta para fora do chunk em direções contrárias (-v contra +v, -u contra +u).
  const base = N * N;

  for (let i = 0; i < res; i++) { // v = 0 (parede olhando para -v)
    const p0 = i, p1 = i + 1;
    const s0 = base + i, s1 = base + i + 1;
    idx[p++] = p0; idx[p++] = s0; idx[p++] = p1;
    idx[p++] = p1; idx[p++] = s0; idx[p++] = s1;
  }

  for (let i = 0; i < res; i++) { // v = 1 (parede olhando para +v)
    const row = (N - 1) * N;
    const p0 = row + i, p1 = row + i + 1;
    const s0 = base + N + i, s1 = base + N + i + 1;
    idx[p++] = p0; idx[p++] = p1; idx[p++] = s0;
    idx[p++] = p1; idx[p++] = s1; idx[p++] = s0;
  }

  for (let j = 0; j < res; j++) { // u = 0 (parede olhando para -u)
    const p0 = j * N, p1 = (j + 1) * N;
    const s0 = base + 2 * N + j, s1 = base + 2 * N + j + 1;
    idx[p++] = p0; idx[p++] = p1; idx[p++] = s0;
    idx[p++] = p1; idx[p++] = s1; idx[p++] = s0;
  }

  for (let j = 0; j < res; j++) { // u = 1 (parede olhando para +u)
    const p0 = j * N + (N - 1), p1 = (j + 1) * N + (N - 1);
    const s0 = base + 3 * N + j, s1 = base + 3 * N + j + 1;
    idx[p++] = p0; idx[p++] = s0; idx[p++] = p1;
    idx[p++] = p1; idx[p++] = s0; idx[p++] = s1;
  }

  return new THREE.BufferAttribute(idx, 1);
}

/** Quantos chunks descarregados guardamos prontos para voltar. */
const CACHE_CAPACITY = 220;

export class ChunkManager {
  /**
   * @param {object} config config do planeta (`createPlanetConfig`)
   * @param {THREE.Object3D} group nó da cena onde os chunks são anexados
   * @param {import('../workers/WorkerPool.js').WorkerPool} pool pool compartilhado
   * @param {number} planetId
   */
  constructor(config, group, pool, planetId) {
    this.config = config;
    this.group = group;
    this.pool = pool;
    this.planetId = planetId;
    /** @type {import('./PropScatter.js').PropScatter | null} */
    this.props = null;

    this.sharedIndex = buildSharedIndex(config.lod.chunkRes);
    this.trianglesPerChunk = this.sharedIndex.count / 3;

    // Material único para TODOS os chunks. Um material por chunk multiplicaria
    // as trocas de estado e as recompilações de shader por nada — a variação
    // de bioma já vem por vertex color.
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.0,
    });
    aplicarDetalheDeSuperficie(this.material, config);

    this.nextId = 1;
    /** Pedidos enfileirados que ainda não foram para nenhum worker. */
    this.pending = new Map();
    /** Pedidos já despachados, aguardando resposta. */
    this.inFlight = new Map();
    /** Ids em voo cujo nó colapsou: a resposta será descartada ao chegar. */
    this.cancelled = new Set();

    /**
     * Cache LRU de chunks descarregados.
     *
     * Voar em círculos sobre uma região faz os mesmos chunks entrarem e saírem
     * o tempo todo. Sem cache, cada volta paga geração completa no worker; com
     * ele, o retorno é instantâneo. `Map` mantém ordem de inserção, então o
     * "menos recentemente usado" é sempre a primeira chave.
     * @type {Map<string, {mesh: THREE.Mesh, props: Float32Array, center: number[]}>}
     */
    this.cache = new Map();
    this.cacheHits = 0;
    this.cacheMisses = 0;

    // Backpressure: manter ~2 jobs por worker é suficiente para nenhum ficar
    // ocioso, sem inflar a fila com trabalho que a câmera já deixou para trás.
    this.maxInFlight = this.pool.size * 2;
    this.activeChunks = 0;
  }

  get isReady() {
    return this.pool.isReady(this.planetId);
  }

  get queueLength() {
    return this.pending.size + this.inFlight.size;
  }

  get triangles() {
    return this.activeChunks * this.trianglesPerChunk;
  }

  /**
   * Props nos 4 níveis de LOD mais finos.
   *
   * Cada nível dobra o raio coberto sem custo proporcional: a densidade por
   * área é constante, então o total de instâncias cresce com a área realmente
   * visível, não com a contagem de chunks. Menos que isso e a vegetação some
   * num anel visível ao redor do jogador; mais, e instanciamos arbustos de meio
   * pixel (o nível 5 dobraria o custo do chunk para isso).
   *
   * ERAM TRÊS NÍVEIS, e o quarto só passou a fazer sentido depois que o
   * espalhamento virou função do LUGAR (ver `scatterProps` no worker). Antes,
   * cada nível gerava props DIFERENTES sobre o mesmo chão, então antecipar a
   * geração só antecipava o embaralhamento. Agora o chunk grosso já traz a
   * vegetação nas posições definitivas, e subdividir não muda nada na tela —
   * o que o nível a mais compra é tempo: a mata começa a carregar a ~250
   * unidades da superfície em vez de ~130, que é a diferença entre chegar num
   * mundo já povoado e vê-lo brotar depois de pousar.
   */
  wantsProps(level) {
    return level >= this.config.lod.maxLevel - 3;
  }

  /**
   * Enfileira a geração da malha de um nó — ou a devolve do cache na hora.
   * @returns {boolean} true se foi servido pelo cache (nó já tem malha)
   */
  request(node) {
    if (node.requestId !== 0) return false;

    const cached = this.cache.get(node.key);
    if (cached) {
      this.cache.delete(node.key);
      this.cacheHits++;
      this.group.add(cached.mesh);
      this.activeChunks++;
      if (this.props && cached.props.length) {
        this.props.addChunk(node.key, cached.props, cached.center);
      }
      node.attachMesh(cached.mesh);
      return true;
    }

    this.cacheMisses++;
    const id = this.nextId++;
    node.requestId = id;
    this.pending.set(id, node);
    return false;
  }

  /** Desiste de um pedido ainda não entregue (o nó colapsou nesse meio tempo). */
  cancel(node) {
    const id = node.requestId;
    if (id === 0) return;

    if (!this.pending.delete(id)) {
      // Não estava na fila => já foi para um worker. Não dá para interromper
      // um worker no meio do job, então marcamos para descartar a resposta.
      this.inFlight.delete(id);
      this.cancelled.add(id);
    }
    node.requestId = 0;
  }

  /**
   * Despacha o que couber, do mais perto para o mais longe.
   * @param {THREE.Vector3} cameraLocal posição da câmera no espaço do planeta
   */
  update(cameraLocal) {
    // A câmera entra aqui porque o repack precisa saber o que está PERTO:
    // quando a vegetação estoura o teto de instâncias, quem sobra tem de ser
    // o que está debaixo do nariz do jogador. Ver `PropScatter.update()`.
    if (this.props) this.props.update(cameraLocal);
    if (!this.isReady || this.pending.size === 0) return;

    let slots = this.maxInFlight - this.pool.inFlight;
    if (slots <= 0) return;

    // Ordenar a cada frame é barato (a fila raramente passa de algumas centenas)
    // e garante que, ao mudar de direção bruscamente, os chunks à frente da
    // nave sejam gerados antes dos que ficaram para trás.
    const entries = [...this.pending.entries()];
    entries.sort(
      (a, b) => a[1].center.distanceToSquared(cameraLocal) - b[1].center.distanceToSquared(cameraLocal)
    );

    for (const [id, node] of entries) {
      if (slots-- <= 0) break;
      this.pending.delete(id);
      this.inFlight.set(id, node);
      this.pool.dispatch({
        type: 'build',
        id,
        planetId: this.planetId,
        face: node.face,
        u0: node.u,
        v0: node.v,
        size: node.size,
        withProps: this.wantsProps(node.level),
      });
    }
  }

  _onChunkReady(payload) {
    // Nó colapsou enquanto o worker trabalhava: o resultado é lixo.
    if (this.cancelled.delete(payload.id)) return;

    const node = this.inFlight.get(payload.id);
    if (!node) return; // planeta descartado no meio do voo
    this.inFlight.delete(payload.id);

    node.requestId = 0;
    node.propsData = payload.props;
    node.propsCenter = payload.center;

    if (this.props && payload.props.length) {
      this.props.addChunk(node.key, payload.props, payload.center);
    }
    node.attachMesh(this._buildMesh(payload));
  }

  _buildMesh(payload) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(payload.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(payload.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(payload.colors, 3));
    geometry.setIndex(this.sharedIndex);

    // Calculada no worker: evita um passe O(n) na main thread por chunk.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), payload.boundingRadius);

    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.position.fromArray(payload.center);
    // Chunks nunca se movem depois de criados: dispensa recalcular a matriz
    // local em todo frame (economia real quando há centenas deles).
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();

    this.group.add(mesh);
    this.activeChunks++;
    return mesh;
  }

  /**
   * Tira o chunk de cena e o guarda no cache (em vez de destruí-lo).
   * @param {import('./QuadTreeNode.js').QuadTreeNode} node
   */
  releaseMesh(node) {
    const mesh = node.mesh;
    if (!mesh) return;

    this.group.remove(mesh);
    this.activeChunks--;
    if (this.props) this.props.removeChunk(node.key);

    this.cache.set(node.key, {
      mesh,
      props: node.propsData ?? new Float32Array(0),
      center: node.propsCenter ?? mesh.position.toArray(),
    });

    while (this.cache.size > CACHE_CAPACITY) {
      const oldestKey = this.cache.keys().next().value;
      const evicted = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      this._disposeMesh(evicted.mesh);
    }
  }

  /**
   * Destrói a malha de um nó SEM guardá-la no cache.
   *
   * É o contrário de `releaseMesh`, e a diferença é o ponto todo: um chunk
   * invalidado por escavação está ERRADO. Mandá-lo para o cache faria o buraco
   * desaparecer assim que o jogador se afastasse e voltasse — o cache serviria
   * o terreno antigo de volta, e o bug pareceria intermitente.
   */
  descartar(node) {
    if (node.requestId !== 0) this.cancel(node);
    if (!node.mesh) return;
    this.group.remove(node.mesh);
    this.activeChunks--;
    if (this.props) this.props.removeChunk(node.key);
    this._disposeMesh(node.mesh);
    node.mesh = null;
    node.propsData = null;
  }

  /**
   * Esvazia do cache tudo que a escavação tornou obsoleto.
   *
   * @param {THREE.Vector3} pontoLocal centro da edição, no espaço do planeta
   * @param {number} raio alcance em unidades de mundo
   */
  purgarCache(pontoLocal, raio) {
    // O raio do chunk entra na conta: um chunk grande cujo CENTRO está longe
    // ainda pode ter a borda dentro da cratera.
    const limite = raio + this.config.radius * 0.05;
    const limiteSq = limite * limite;
    let removidos = 0;

    for (const [chave, entrada] of this.cache) {
      const [x, y, z] = entrada.center;
      const dx = x - pontoLocal.x, dy = y - pontoLocal.y, dz = z - pontoLocal.z;
      if (dx * dx + dy * dy + dz * dz > limiteSq) continue;
      this.cache.delete(chave);
      this._disposeMesh(entrada.mesh);
      removidos++;
    }
    return removidos;
  }

  _disposeMesh(mesh) {
    // CRÍTICO: soltar o índice antes do dispose. `geometry.dispose()` avisa o
    // renderer para liberar o buffer de CADA atributo — inclusive o índice
    // compartilhado, que seria descartado debaixo dos outros 300 chunks.
    mesh.geometry.setIndex(null);
    mesh.geometry.dispose();
  }

  dispose() {
    for (const entry of this.cache.values()) this._disposeMesh(entry.mesh);
    this.cache.clear();
    this.material.dispose();
    this.pending.clear();
    this.inFlight.clear();
    this.cancelled.clear();
  }
}
