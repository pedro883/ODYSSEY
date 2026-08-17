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
 * Está em `intercepcao.js`, junto com a dedução. Ela saiu daqui quando as torres
 * da base passaram a precisar da mesma antecipação: manter duas cópias de uma
 * regra de combate é o caminho conhecido para a nave e a torre errarem de formas
 * diferentes sem motivo aparente.
 */

import * as THREE from 'three';
import { pontoDeIntercepcao } from './intercepcao.js';

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

    const resolvido = pontoDeIntercepcao(
      this.pontoDeMira,
      posicaoNave,
      melhor.posicao,
      melhor.velocidade ?? _relativa.set(0, 0, 0),
      VELOCIDADE
    );
    if (!resolvido) return null;

    this.temMira = true;
    return this.pontoDeMira;
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
