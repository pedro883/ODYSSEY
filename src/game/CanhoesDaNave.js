/**
 * Canhões da nave e mira preditiva.
 *
 * ===========================================================================
 * POR QUE O *LEAD INDICATOR* JÁ ESTAVA PAGO
 * ===========================================================================
 * Ele só existe porque o tiro tem TEMPO DE VOO. Foi a razão de `Weapons.js`
 * usar projéteis em vez de raio instantâneo, mesmo custando mais: com hitscan
 * o alvo é atingido no quadro do disparo e não há nada a antecipar — a mecânica
 * inteira desaparece.
 *
 * ===========================================================================
 * A CONTA
 * ===========================================================================
 * Dado o alvo em `P` movendo-se a `V`, a nave em `S` e o projétil a `s`, quer-se
 * o instante `t` em que a bala alcança o alvo:
 *
 *     |P + V·t − S| = s·t
 *
 * Elevando ao quadrado, com `D = P − S`:
 *
 *     (V·V − s²)·t² + 2(V·D)·t + D·D = 0
 *
 * Uma quadrática comum, com três detalhes que decidem se ela serve na prática:
 *
 *   - QUANDO `a ≈ 0` (o alvo foge exatamente à velocidade da bala) ela degenera
 *     em linear. Tratar isso como caso especial evita divisão por zero
 *     justamente na perseguição mais tensa do jogo.
 *   - DAS DUAS RAÍZES interessa a MENOR positiva: é o primeiro encontro. A
 *     maior corresponde à bala alcançando o alvo depois de ele passar por ela,
 *     o que é matemática válida e mira absurda.
 *   - SEM RAIZ POSITIVA não há interceptação possível — o alvo é rápido demais
 *     ou está se afastando rápido demais. Aí a interface precisa dizer isso, e
 *     não apontar para um lugar qualquer.
 */

import * as THREE from 'three';

/** Segundos entre disparos. */
const CADENCIA = 0.16;

/** Velocidade do projétil, em unidades por segundo. */
const VELOCIDADE = 420;

/** Dano por tiro. */
const DANO = 14;

/** Alcance antes de expirar. */
const ALCANCE = 1400;

/** Afastamento lateral da boca de cada canhão. */
const BOCA_LATERAL = 1.1;

/** Até onde a mira preditiva procura alvo. */
const ALCANCE_MIRA = 1200;

const _dir = new THREE.Vector3();
const _lado = new THREE.Vector3();
const _cima = new THREE.Vector3();
const _boca = new THREE.Vector3();
const _D = new THREE.Vector3();
const _relativa = new THREE.Vector3();

export class CanhoesDaNave {
  /**
   * @param {import('./Weapons.js').Projeteis} projeteis
   */
  constructor(projeteis) {
    this.projeteis = projeteis;
    this._recarga = 0;
    /** Alternância entre canhão esquerdo e direito. */
    this._lado = 1;

    /**
     * Onde mirar para acertar o alvo atual, em espaço de cena.
     * `null` quando não há alvo ou a interceptação é impossível.
     * @type {THREE.Vector3|null}
     */
    this.pontoDeMira = new THREE.Vector3();
    this.temMira = false;
    this.alvoMirado = null;

    /** @type {(() => void) | null} */
    this.aoDisparar = null;
  }

  atualizar(dt) {
    if (this._recarga > 0) this._recarga -= dt;
  }

  /**
   * Escolhe o alvo mais alinhado com o nariz e calcula a antecipação.
   *
   * O critério é ALINHAMENTO e não distância: numa perseguição o que o piloto
   * quer mirar é o que está à frente, e o inimigo mais próximo pode estar atrás
   * dele. Distância entra só como desempate através do alcance.
   *
   * @param {THREE.Vector3} posicaoNave
   * @param {THREE.Vector3} frente direção do nariz, unitária
   * @param {Array<{posicao:THREE.Vector3, velocidade?:THREE.Vector3, vitais?:object, dono?:any}>} alvos
   * @param {any} dono para não mirar em si mesmo
   */
  mirar(posicaoNave, frente, alvos, dono) {
    let melhor = null;
    let melhorAlinhamento = 0.55; // ~57 graus: fora disso não é "à frente"

    for (const alvo of alvos) {
      if (alvo.dono === dono) continue;
      if (alvo.vitais && !alvo.vitais.vivo) continue;

      _D.copy(alvo.posicao).sub(posicaoNave);
      const dist = _D.length();
      if (dist < 1e-3 || dist > ALCANCE_MIRA) continue;

      const alinhamento = _D.dot(frente) / dist;
      if (alinhamento > melhorAlinhamento) {
        melhorAlinhamento = alinhamento;
        melhor = alvo;
      }
    }

    this.alvoMirado = melhor;
    this.temMira = false;
    if (!melhor) return null;

    const t = this._tempoDeIntercepcao(
      posicaoNave,
      melhor.posicao,
      melhor.velocidade ?? _relativa.set(0, 0, 0)
    );
    if (t === null) return null;

    this.pontoDeMira
      .copy(melhor.posicao)
      .addScaledVector(melhor.velocidade ?? _relativa.set(0, 0, 0), t);
    this.temMira = true;
    return this.pontoDeMira;
  }

  /**
   * Resolve `|P + V·t − S| = s·t`. Ver a dedução no topo do arquivo.
   * @returns {number|null} instante do encontro, ou null se não houver
   */
  _tempoDeIntercepcao(origem, alvo, velocidadeAlvo) {
    _D.copy(alvo).sub(origem);

    const a = velocidadeAlvo.lengthSq() - VELOCIDADE * VELOCIDADE;
    const b = 2 * velocidadeAlvo.dot(_D);
    const c = _D.lengthSq();

    // Alvo à mesma velocidade da bala: a quadrática vira linear.
    if (Math.abs(a) < 1e-6) {
      if (Math.abs(b) < 1e-9) return null;
      const t = -c / b;
      return t > 0 ? t : null;
    }

    const disc = b * b - 4 * a * c;
    if (disc < 0) return null; // interceptação impossível

    const raiz = Math.sqrt(disc);
    const t1 = (-b - raiz) / (2 * a);
    const t2 = (-b + raiz) / (2 * a);

    // A MENOR positiva: o primeiro encontro.
    const candidatos = [t1, t2].filter((t) => t > 0).sort((x, y) => x - y);
    return candidatos.length ? candidatos[0] : null;
  }

  /**
   * Dispara, se a recarga permitir.
   *
   * @param {THREE.Vector3} posicao da nave
   * @param {THREE.Quaternion} orientacao da nave
   * @param {THREE.Vector3} velocidadeNave somada à do projétil
   * @param {any} dono
   */
  disparar(posicao, orientacao, velocidadeNave, dono) {
    if (this._recarga > 0) return false;
    this._recarga = CADENCIA;

    _dir.set(0, 0, -1).applyQuaternion(orientacao);
    _lado.set(1, 0, 0).applyQuaternion(orientacao);
    _cima.set(0, 1, 0).applyQuaternion(orientacao);

    // Alterna entre os dois canhões: as duas bocas piscando em revezamento é o
    // que faz uma nave parecer ter armamento, em vez de um cano só no meio.
    this._lado = -this._lado;
    _boca
      .copy(posicao)
      .addScaledVector(_dir, 1.6)
      .addScaledVector(_lado, BOCA_LATERAL * this._lado)
      .addScaledVector(_cima, -0.2);

    // A direção sai da BOCA até o ponto de mira, e não do eixo da nave: é o que
    // faz os dois canhões convergirem no alvo em vez de atirarem paralelos.
    const destino = this.temMira ? this.pontoDeMira : _relativa.copy(posicao).addScaledVector(_dir, 600);

    this.projeteis.disparar({
      origem: _boca,
      direcao: _relativa.copy(destino).sub(_boca).normalize(),
      velocidade: VELOCIDADE,
      dano: DANO,
      alcance: ALCANCE,
      cor: 0x9effc8,
      dono,
      velocidadeBase: velocidadeNave,
    });

    this.aoDisparar?.();
    return true;
  }
}

export { VELOCIDADE as VELOCIDADE_CANHAO };
