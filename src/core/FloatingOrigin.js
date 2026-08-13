/**
 * Origem flutuante: o jogador nunca se afasta muito de (0,0,0) — o mundo é que
 * anda por baixo dele.
 *
 * ---------------------------------------------------------------------------
 * O PROBLEMA
 * ---------------------------------------------------------------------------
 * Um `float32` tem 24 bits de mantissa: ~7 dígitos decimais SIGNIFICATIVOS, não
 * 7 casas. A precisão absoluta, portanto, piora com a distância à origem:
 *
 *   | distância | menor diferença representável |
 *   |-----------|------------------------------|
 *   |     1 000 | 0,00006 u                    |
 *   |    60 000 | 0,004 u                      |
 *   | 1 000 000 | 0,06 u                       |
 *
 * A `position` dos objetos é `float64` no JavaScript, então a CPU não sofre. O
 * problema mora na GPU: as matrizes vão para o shader como `float32`, e o
 * vértice é transformado lá. A 60 000 unidades o erro já é da ordem de
 * milímetros — invisível. A 1 000 000 é de centímetros, e uma nave parada
 * começa a TREMER, porque o erro de arredondamento muda de um frame para o
 * outro conforme a câmera se move.
 *
 * Este sistema resolve isso na raiz: sempre que a câmera passa do limiar,
 * subtraímos a posição dela de TUDO o que é absoluto. A geometria relativa não
 * muda em nada — todo mundo andou o mesmo tanto — mas os números voltam a ser
 * pequenos, e a precisão volta ao topo da tabela.
 *
 * ---------------------------------------------------------------------------
 * A REGRA QUE NÃO PODE SER QUEBRADA
 * ---------------------------------------------------------------------------
 * O rebase precisa ser ATÔMICO: ou tudo desloca no mesmo frame, ou nada
 * desloca. Um único objeto esquecido não fica "um pouco errado" — ele salta
 * dezenas de milhares de unidades de uma vez.
 *
 * É por isso que registrar é explícito e não automático (varrer `scene.children`
 * pegaria também o campo de estrelas, que ACOMPANHA a câmera de propósito e
 * deve continuar onde está). Ao adicionar qualquer coisa nova com posição de
 * mundo, registre aqui — ou ela vai ficar para trás.
 */

import * as THREE from 'three';

export class FloatingOrigin {
  /**
   * @param {number} threshold distância da origem que dispara o rebase
   *
   *   Não é "quanto antes, melhor". Cada rebase toca todos os registrados e
   *   invalida as matrizes de mundo; com um limiar pequeno, voar rápido faria
   *   isso vários frames seguidos. Alguns milhares de unidades mantêm o erro
   *   de precisão na casa do micrômetro e o rebase raro.
   */
  constructor(threshold = 4096) {
    this.threshold = threshold;
    this.thresholdSq = threshold * threshold;

    /**
     * Deslocamento acumulado: a posição de mundo "verdadeira" de um objeto é
     * `objeto.position + origin`.
     *
     * Guardado como `Vector3` comum, que em JS é `float64`: mesmo depois de
     * milhões de unidades acumuladas ele não perde precisão. Serve para HUD,
     * coordenadas de save e qualquer coisa que precise do valor absoluto.
     */
    this.origin = new THREE.Vector3();

    /** @type {THREE.Object3D[]} */
    this.objects = [];
    /** @type {THREE.Vector3[]} */
    this.vectors = [];
    /** @type {Array<(delta: THREE.Vector3) => void>} */
    this.handlers = [];

    this.shifts = 0;
    this._delta = new THREE.Vector3();
  }

  /** Objetos cuja `position` é absoluta (planetas, nave, efeitos no mundo). */
  add(...objects) {
    this.objects.push(...objects);
    return this;
  }

  /** Vetores soltos que guardam posição de mundo (o jogador a pé). */
  addVector(...vectors) {
    this.vectors.push(...vectors);
    return this;
  }

  /** Para quem precisa reagir ao rebase de um jeito próprio (uniforms). */
  onShift(handler) {
    this.handlers.push(handler);
    return this;
  }

  /**
   * Recentraliza se a câmera passou do limiar.
   *
   * @param {THREE.Camera} camera
   * @returns {boolean} houve rebase neste frame?
   */
  update(camera) {
    if (camera.position.lengthSq() < this.thresholdSq) return false;

    // O delta é a posição INTEIRA da câmera: ela volta exatamente para a
    // origem. Snap numa grade seria útil se algo dependesse de coordenadas
    // alinhadas (terreno em tiles, por exemplo); aqui nada depende, e voltar
    // ao zero exato dá o maior intervalo possível até o próximo rebase.
    const delta = this._delta.copy(camera.position);

    for (const object of this.objects) object.position.sub(delta);
    for (const vector of this.vectors) vector.sub(delta);
    camera.position.set(0, 0, 0);

    // Acumula no sentido oposto: o mundo andou -delta, logo a origem do mundo
    // está agora em +delta em relação a onde estava.
    this.origin.add(delta);
    this.shifts++;

    for (const handler of this.handlers) handler(delta);
    return true;
  }

  /**
   * Converte uma posição da cena para coordenada absoluta do universo.
   * @param {THREE.Vector3} local
   * @param {THREE.Vector3} [target]
   */
  toAbsolute(local, target = new THREE.Vector3()) {
    return target.copy(local).add(this.origin);
  }
}
