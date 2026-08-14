/**
 * Nó da quadtree de superfície.
 *
 * O planeta é um cubo de 6 faces projetado numa esfera; cada face é a raiz de
 * uma quadtree. Um nó ou desenha a si mesmo, ou delega para 4 filhos com o
 * dobro da densidade de vértices. Como a subdivisão só acontece perto da
 * câmera, o custo é O(log) da distância em vez de O(área do planeta).
 *
 * ---------------------------------------------------------------------------
 * INVARIANTE DE RENDERIZAÇÃO (a parte que realmente importa)
 * ---------------------------------------------------------------------------
 * A geração é assíncrona: quando um nó decide dividir, os 4 filhos ainda não
 * existem na GPU. Duas armadilhas clássicas:
 *
 *   a) esconder o pai imediatamente  -> abre um buraco no planeta;
 *   b) mostrar pai E filhos juntos   -> duas superfícies quase coplanares
 *                                       brigando no depth buffer (z-fighting).
 *
 * A regra aqui evita as duas: **exatamente um nível cobre cada área**. Ou o pai
 * desenha (e toda a subárvore fica escondida), ou os 4 filhos estão prontos e
 * o pai some. `update()` devolve `true` quando este nó garantiu a cobertura da
 * sua área — é esse retorno que sustenta a invariante recursivamente.
 */

import * as THREE from 'three';
import { faceDirection } from '../shared/terrain.js';
import { chunkKey } from './ChunkManager.js';

const _dir = [0, 0, 0];

/**
 * Frames de cobertura contínua antes de devolver a malha do pai ao cache.
 *
 * Devolver no primeiro frame parece ótimo para a memória, mas produz churn:
 * basta um neto colapsar para o pai ter que pedir tudo de novo. Esta carência
 * mantém o split/merge instantâneo no vaivém típico do voo.
 */
const RELEASE_GRACE_FRAMES = 90;

export class QuadTreeNode {
  /**
   * @param {import('./Planet.js').Planet} planet
   * @param {number} face índice em CUBE_FACES
   * @param {number} u canto do retângulo na face, em [0,1]
   * @param {number} v canto do retângulo na face, em [0,1]
   * @param {number} size lado do retângulo (1 = face inteira)
   * @param {number} level profundidade na árvore
   */
  constructor(planet, face, u, v, size, level) {
    this.planet = planet;
    this.face = face;
    this.u = u;
    this.v = v;
    this.size = size;
    this.level = level;
    this.key = chunkKey(face, u, v, size);

    /** @type {QuadTreeNode[] | null} */
    this.children = null;
    /** @type {THREE.Mesh | null} */
    this.mesh = null;
    /** Id do job no ChunkManager; 0 = nenhum pedido em aberto. */
    this.requestId = 0;
    this._coveredFrames = 0;

    /** Buffer de props devolvido pelo worker (guardado para o cache). */
    this.propsData = null;
    this.propsCenter = null;

    // Centro do chunk JÁ deslocado pelo relevo. Usar o raio médio faria o LOD
    // subdividir tarde demais no alto de uma montanha: a câmera está perto da
    // superfície real, mas longe da esfera "lisa" de referência.
    faceDirection(face, u + size * 0.5, v + size * 0.5, _dir);
    const elev = planet.sampler.heightAt(_dir[0], _dir[1], _dir[2]);
    const r = planet.config.radius + elev;
    this.center = new THREE.Vector3(_dir[0] * r, _dir[1] * r, _dir[2] * r);
    this.centerDir = new THREE.Vector3(_dir[0], _dir[1], _dir[2]);

    // Comprimento aproximado da aresta do chunk em unidades de mundo.
    this.worldSize = 2 * planet.config.radius * size;
  }

  /**
   * O chunk está do outro lado do planeta?
   *
   * O frustum culling não resolve isso: um chunk atrás do horizonte está DENTRO
   * do campo de visão, só escondido pela curvatura. O ganho é grande quando se
   * voa baixo — ali os chunks logo além do horizonte estão a poucas unidades de
   * distância e seriam subdivididos ao máximo sem nunca aparecer na tela.
   *
   * Um ponto da esfera é visível de uma câmera a distância D do centro quando
   * `cos(ângulo) >= R/D`. Usamos R reduzido pela elevação máxima para não
   * cortar o pico de uma montanha que espia por cima do horizonte.
   *
   * @param {THREE.Vector3} cameraLocal
   */
  isBeyondHorizon(cameraLocal) {
    const distance = cameraLocal.length();
    const cfg = this.planet.config;

    // De dentro da superfície (ou muito rente) o teste não vale.
    if (distance <= cfg.radius + cfg.maxElevation) return false;

    const safeRadius = cfg.radius - cfg.maxElevation;
    const cosHorizon = safeRadius / distance;

    const cosNode = this.centerDir.dot(cameraLocal) / distance;

    // Margem pela abertura angular do próprio chunk: sem ela, a borda de um
    // chunk grande seria cortada mesmo com parte dele acima do horizonte.
    const margin = this.size * 1.6;
    return cosNode < cosHorizon - margin;
  }

  /**
   * @param {THREE.Vector3} cameraLocal posição da câmera no espaço do planeta
   * @returns {boolean} true se este nó garantiu a cobertura da sua área
   */
  update(cameraLocal) {
    const lod = this.planet.config.lod;

    if (this.isBeyondHorizon(cameraLocal)) {
      // Invisível: não desenha, não pede geometria e poda a subárvore inteira.
      // Devolve `true` porque a área está "resolvida" — o pai não precisa
      // desenhar no lugar dela.
      this._setVisible(false);
      this._hideSubtree();
      if (this.requestId !== 0) this.planet.chunks.cancel(this);
      return true;
    }

    // Distância até a BORDA do chunk, não até o centro. Sem esse ajuste um
    // chunk grande visto de rasante nunca subdivide (o centro fica longe) e o
    // terreno logo à frente da nave aparece em baixa resolução.
    const distance = Math.max(0, cameraLocal.distanceTo(this.center) - this.worldSize * 0.5);
    const wantSplit = this.level < lod.maxLevel && distance < this.worldSize * lod.splitFactor;

    if (wantSplit) {
      if (!this.children) this._createChildren();

      let allCovered = true;
      for (const child of this.children) {
        if (!child.update(cameraLocal)) allCovered = false;
      }

      if (allCovered) {
        // Os filhos cobrem toda a área: a malha grosseira sai de cena.
        this._setVisible(false);
        if (++this._coveredFrames > RELEASE_GRACE_FRAMES) this._releaseMesh();
        return true;
      }

      // Faltam filhos. Se temos a malha grosseira, ela segura a área inteira
      // — e a subárvore some para não disputar o depth buffer com ela.
      this._coveredFrames = 0;
      this._ensureMesh();
      if (this.mesh) {
        this._setVisible(true);
        this._hideSubtree();
        return true;
      }

      // Nem pai nem filhos prontos: devolve false e deixa um ancestral cobrir.
      // Só acontece no carregamento inicial do planeta.
      return false;
    }

    // --- Este nó é a folha desejada ---------------------------------------
    this._coveredFrames = 0;
    this._ensureMesh();

    if (this.mesh) {
      this._setVisible(true);
      this._disposeChildren();
      return true;
    }

    // Malha própria ainda em geração. Se já há filhos (merge em andamento),
    // eles continuam desenhando até a substituição chegar.
    if (this.children) {
      let allCovered = true;
      for (const child of this.children) {
        if (!child.update(cameraLocal)) allCovered = false;
      }
      return allCovered;
    }

    return false;
  }

  /**
   * Joga fora a geometria desta subárvore onde a escavação chegou.
   *
   * Percorre de cima para baixo e poda cedo: um nó cuja calota nem encosta na
   * edição não pode ter descendente que encoste, então a recursão inteira
   * morre ali. Numa quadtree de 6 raízes isso reduz milhares de nós a algumas
   * dezenas de testes.
   *
   * Não recria nada: o `update()` do próximo frame vê `mesh === null` e pede a
   * malha de novo, agora com o campo de edições já atualizado nos workers.
   *
   * @param {THREE.Vector3} dirCentro direção unitária do centro da edição
   * @param {number} raioAngular abertura da edição, em radianos
   * @returns {number} quantos nós foram descartados
   */
  invalidar(dirCentro, raioAngular) {
    // `size` 1 cobre uma face inteira (~90° = 1,57 rad), daí o fator ~1,6.
    //
    // A célula extra é o ANEL DE PADDING: o worker amostra um anel além da
    // borda de cada chunk para que as normais fechem na costura com o vizinho
    // (ver `buildChunk`). Um chunk cujo corpo não encosta na escavação mas cujo
    // padding sim teria as normais da borda calculadas com o relevo antigo — e
    // sobraria um vinco de iluminação exatamente na emenda, que é o tipo de
    // defeito que se nota mais do que o buraco em si.
    const celula = this.size / this.planet.config.lod.chunkRes;
    const alcance = raioAngular + (this.size + celula) * 1.6;
    if (this.centerDir.dot(dirCentro) < Math.cos(Math.min(Math.PI, alcance))) return 0;

    let total = 0;
    if (this.mesh || this.requestId !== 0) {
      this.planet.chunks.descartar(this);
      total++;
    }

    // O centro guardado veio da altura ANTIGA. Ele governa a decisão de
    // subdividir, então deixá-lo defasado faria o LOD tratar o fundo de uma
    // cratera nova como se ainda fosse o topo do morro que estava ali.
    faceDirection(this.face, this.u + this.size * 0.5, this.v + this.size * 0.5, _dir);
    const r = this.planet.config.radius + this.planet.sampler.heightAt(_dir[0], _dir[1], _dir[2]);
    this.center.set(_dir[0] * r, _dir[1] * r, _dir[2] * r);

    if (this.children) {
      for (const child of this.children) total += child.invalidar(dirCentro, raioAngular);
    }
    return total;
  }

  /** Chamado pelo ChunkManager quando o worker entrega a geometria. */
  attachMesh(mesh) {
    this.mesh = mesh;
    // Nasce escondida: quem decide exibir é o `update()` do próximo frame,
    // respeitando a invariante de cobertura.
    mesh.visible = false;
  }

  _ensureMesh() {
    if (this.mesh || this.requestId !== 0) return;
    // Pode voltar do cache já resolvido — nesse caso `this.mesh` fica setado.
    this.planet.chunks.request(this);
  }

  _setVisible(visible) {
    if (!this.mesh) return;
    this.mesh.visible = visible;
    // A vegetação acompanha a visibilidade do terreno, não a sua existência:
    // um chunk carregado mas escondido (porque os filhos assumiram) não pode
    // continuar contribuindo props. Ver `PropScatter.setVisible()`.
    this.planet.props.setVisible(this.key, visible);
  }

  /** Esconde (sem destruir) toda a subárvore — usado quando o pai assume. */
  _hideSubtree() {
    if (!this.children) return;
    for (const child of this.children) {
      child._setVisible(false);
      child._hideSubtree();
    }
  }

  _releaseMesh() {
    if (this.requestId !== 0) this.planet.chunks.cancel(this);
    if (this.mesh) {
      this.planet.chunks.releaseMesh(this);
      this.mesh = null;
    }
    this._coveredFrames = 0;
  }

  _createChildren() {
    const h = this.size * 0.5;
    const L = this.level + 1;
    this.children = [
      new QuadTreeNode(this.planet, this.face, this.u, this.v, h, L),
      new QuadTreeNode(this.planet, this.face, this.u + h, this.v, h, L),
      new QuadTreeNode(this.planet, this.face, this.u, this.v + h, h, L),
      new QuadTreeNode(this.planet, this.face, this.u + h, this.v + h, h, L),
    ];
  }

  _disposeChildren() {
    if (!this.children) return;
    for (const child of this.children) child.dispose();
    this.children = null;
  }

  dispose() {
    this._disposeChildren();
    this._releaseMesh();
  }
}
