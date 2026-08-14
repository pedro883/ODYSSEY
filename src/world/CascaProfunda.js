/**
 * Faixas radiais profundas: o terreno abaixo do que a quadtree desenha.
 *
 * ===========================================================================
 * O PROBLEMA
 * ===========================================================================
 * A quadtree subdivide só nos eixos ANGULARES `(face, u, v)`. No modo
 * volumétrico cada nó dela vira uma casca de espessura fixa: da superfície até
 * 90 unidades abaixo da elevação mínima do chunk (a faixa 0).
 *
 * Cavernas mais fundas que isso existem no campo — a sonda as encontra, a
 * colisão as respeita — e simplesmente NÃO SÃO DESENHADAS. Descendo por uma
 * boca, passados os 90 metros, o jogador atravessaria geometria inexistente.
 *
 * ===========================================================================
 * POR QUE ISTO É UMA ESTRUTURA À PARTE, E NÃO UM CAMPO NO `QuadTreeNode`
 * ===========================================================================
 * O caminho "óbvio" seria dar várias malhas a cada nó da quadtree. Ele toca
 * `attachMesh`, `releaseMesh`, `setVisible`, `dispose`, a chave do cache e a
 * chave dos props — seis pontos de um sistema que hoje sustenta centenas de
 * chunks sem falha, e que continua sendo o único caminho quando o modo
 * volumétrico está desligado.
 *
 * Aqui a observação que evita tudo isso: **as faixas profundas só interessam
 * onde o jogador está**. Ninguém precisa ver o subsolo de um continente do
 * outro lado do planeta. Então elas não precisam de LOD, nem de cache, nem de
 * hierarquia — precisam de um punhado de blocos ao redor de quem desceu, que
 * nascem quando ele entra e somem quando ele sai.
 *
 * Isso cabe num mapa simples, sem tocar na quadtree. O custo é não ter LOD nas
 * faixas profundas; como elas só existem a poucas dezenas de metros do jogador,
 * não faz falta.
 *
 * ===========================================================================
 * DE ONDE VÊM OS BLOCOS ANGULARES
 * ===========================================================================
 * Da própria quadtree. Ela já subdivide em direção à câmera, então as folhas
 * mais finas perto dela são exatamente o recorte angular desejado — e
 * reaproveitá-las evita ter de inverter a projeção do cubo esferificado, que
 * não tem forma fechada.
 */

import * as THREE from 'three';

/** Espessura de cada faixa, em unidades. */
const ESPESSURA = 110;

/** Onde a faixa 0 (a da quadtree) termina. */
const INICIO = 90;

/** Quantas faixas existem abaixo da 0. */
const MAXIMO_FAIXAS = 3;

/**
 * Distância angular máxima, em múltiplos do tamanho do bloco, para um bloco
 * entrar em cena. 1 = só o de baixo do jogador e os vizinhos imediatos.
 */
const RAIO_BLOCOS = 1.5;

export class CascaProfunda {
  /**
   * @param {import('./Planet.js').Planet} planeta
   * @param {THREE.Object3D} grupo nó de cena, em espaço local do planeta
   */
  constructor(planeta, grupo) {
    this.planeta = planeta;
    this.grupo = grupo;

    /** @type {Map<string, {mesh: THREE.Mesh|null, id: number, faixa: number}>} */
    this.blocos = new Map();
    this.proximoId = 1_000_000; // faixa própria de ids, longe da quadtree
    /** @type {Map<number, string>} id em voo -> chave */
    this.emVoo = new Map();

    this._tmp = new THREE.Vector3();
  }

  get ativos() {
    let n = 0;
    for (const b of this.blocos.values()) if (b.mesh) n++;
    return n;
  }

  /**
   * @param {THREE.Vector3} cameraLocal câmera em espaço local do planeta
   * @param {number} elevacao elevação do terreno sob a câmera
   */
  atualizar(cameraLocal, elevacao) {
    const cfg = this.planeta.config;
    const distancia = cameraLocal.length();
    const superficie = cfg.radius + elevacao;
    const profundidade = superficie - distancia;

    // Acima da faixa 0 não há nada a fazer, e há muito a desfazer: sair da
    // caverna precisa devolver a memória e as chamadas de desenho.
    if (profundidade < INICIO * 0.6) {
      if (this.blocos.size) this.limpar();
      return;
    }

    const faixa = Math.min(
      MAXIMO_FAIXAS,
      Math.max(1, Math.ceil((profundidade - INICIO) / ESPESSURA) + 1)
    );

    // As folhas da quadtree perto da câmera dão o recorte angular.
    const folhas = [];
    for (const raiz of this.planeta.roots) this._coletarFolhas(raiz, cameraLocal, folhas);

    const desejados = new Set();
    for (const folha of folhas) {
      // A faixa do jogador e a de baixo: descer não pode revelar o vazio um
      // instante antes de o bloco seguinte chegar.
      for (const f of [faixa, faixa + 1]) {
        if (f > MAXIMO_FAIXAS) continue;
        const chave = `${folha.key}|${f}`;
        desejados.add(chave);
        if (!this.blocos.has(chave)) this._pedir(folha, f, chave);
      }
    }

    for (const [chave, bloco] of this.blocos) {
      if (desejados.has(chave)) continue;
      this._descartar(chave, bloco);
    }
  }

  /** Folhas da quadtree próximas da câmera, no nível mais fino disponível. */
  _coletarFolhas(no, cameraLocal, saida) {
    if (no.children) {
      for (const filho of no.children) this._coletarFolhas(filho, cameraLocal, saida);
      return;
    }
    // `worldSize` é a aresta do nó em unidades de mundo; usá-la como régua faz
    // o raio de coleta acompanhar o nível de subdivisão sem número mágico.
    const limite = no.worldSize * RAIO_BLOCOS;
    if (no.center.distanceTo(cameraLocal) <= limite) saida.push(no);
  }

  _pedir(folha, faixa, chave) {
    const id = this.proximoId++;
    this.blocos.set(chave, { mesh: null, id, faixa });
    this.emVoo.set(id, chave);

    this.planeta.pool.dispatch({
      type: 'build',
      id,
      planetId: this.planeta.planetId,
      face: folha.face,
      u0: folha.u,
      v0: folha.v,
      size: folha.size,
      withProps: false, // não há vegetação no subsolo
      volumetrico: true,
      profundidadeDe: INICIO + (faixa - 1) * ESPESSURA,
      profundidadeAte: INICIO + faixa * ESPESSURA,
    });
  }

  /**
   * O chunk chegou. Devolve `true` se era nosso — é assim que o `ChunkManager`
   * sabe que não deve tratá-lo como um nó da quadtree.
   */
  aceitar(payload, construirMalha) {
    const chave = this.emVoo.get(payload.id);
    if (chave === undefined) return false;
    this.emVoo.delete(payload.id);

    const bloco = this.blocos.get(chave);
    // Descartado enquanto o worker trabalhava (o jogador subiu).
    if (!bloco || bloco.id !== payload.id) return true;

    // Malha vazia acontece e é normal: uma faixa profunda sem caverna nenhuma
    // é rocha maciça, e rocha maciça não tem superfície.
    if (payload.indices && payload.indices.length > 0) {
      bloco.mesh = construirMalha(payload);
      this.grupo.add(bloco.mesh);
    }
    return true;
  }

  _descartar(chave, bloco) {
    if (bloco.mesh) {
      bloco.mesh.geometry.dispose();
      bloco.mesh.removeFromParent();
    }
    this.emVoo.delete(bloco.id);
    this.blocos.delete(chave);
  }

  limpar() {
    for (const [chave, bloco] of this.blocos) this._descartar(chave, bloco);
    this.blocos.clear();
    this.emVoo.clear();
  }

  dispose() {
    this.limpar();
  }
}
