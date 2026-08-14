/**
 * Blaster de plasma: a arma de mão.
 *
 * Separado de `Weapons.js` de propósito. Aquele arquivo é o TRANSPORTE — como um
 * projétil voa, colide e some — e vai servir igual aos canhões da nave, às
 * torretas da base e ao tiro dos drones. Este é a ARMA: cadência, dispersão,
 * calor e o que a granada faz ao encostar no chão. Misturar os dois faria o
 * canhão da nave herdar o sobreaquecimento do blaster sem ninguém ter pedido.
 *
 * ===========================================================================
 * CALOR NO LUGAR DE MUNIÇÃO
 * ===========================================================================
 * Munição contável obrigaria a inventário, recarga, drop e economia — quatro
 * sistemas para uma arma que ainda não tem inimigo. Calor entrega a mesma
 * função de projeto (não dá para segurar o gatilho para sempre) com um número
 * só, e é o que o gênero usa.
 *
 * O detalhe que faz a mecânica funcionar é o TRAVAMENTO: ao encostar no teto, a
 * arma não volta a atirar assim que o calor cai um pouco — ela fica bloqueada
 * até esfriar quase por completo. Sem isso o jogador dispara em rajadas de um
 * tiro no limite do medidor e o superaquecimento nunca custa nada.
 */

import * as THREE from 'three';

/** Segundos entre disparos do tiro primário. */
const CADENCIA = 0.11;

/** Calor por disparo, em frações do medidor. */
const CALOR_POR_TIRO = 0.075;

/** Frações por segundo que o medidor perde parado. */
const RESFRIAMENTO = 0.42;

/**
 * Atraso antes de começar a esfriar, em segundos.
 *
 * Mesmo papel do atraso do escudo em `Vitals.js`: é ele, e não a taxa, que faz
 * o jogador soltar o gatilho.
 */
const ESPERA_RESFRIAMENTO = 0.45;

/** Abaixo deste calor a arma travada volta a funcionar. */
const LIMIAR_DESTRAVA = 0.15;

/** Meio-ângulo do cone de dispersão, em radianos. */
const DISPERSAO = 0.009;

/**
 * Deslocamento lateral da boca da arma em relação ao olho, em unidades.
 *
 * Grande o bastante para o traçante nascer FORA do eixo da câmera. Com o valor
 * anterior (0,22) o tiro ainda saía praticamente do olho e continuava invisível.
 */
const DESLOCAMENTO_BOCA = 0.5;

/**
 * Distância em que o tiro cruza o centro do retículo, em unidades.
 *
 * Curta demais e o traçante vira um risco na cara do jogador; longa demais e ele
 * volta a sair paralelo ao olhar, que é o defeito que a convergência existe para
 * resolver.
 */
const CONVERGENCIA = 55;

/** Tempo de recarga da granada, em segundos. */
const CADENCIA_GRANADA = 1.4;

// -----------------------------------------------------------------------------
// DOIS TEMPORÁRIOS, E NÃO UM.
//
// `_boca` e `_visar` são chamados no MESMO literal de objeto passado a
// `disparar`. Com um temporário só, o segundo a executar sobrescrevia o
// resultado do primeiro e as duas chaves apontavam para o mesmo vetor: o tiro
// nascia na DIREÇÃO em vez de na boca da arma — isto é, a poucas unidades da
// origem da cena, a milhares de unidades do jogador.
//
// O sintoma era não ver traçante nenhum, com tudo o mais correto: o espaçamento
// entre tiros batia com a velocidade configurada, a colisão funcionava, o
// contador de vivos subia. Só o ponto de partida estava errado, e ele é a única
// coisa que a tela mostra.
// -----------------------------------------------------------------------------
const _origem = new THREE.Vector3();
const _mira = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _lado = new THREE.Vector3();
const _cima = new THREE.Vector3();
const _acima = new THREE.Vector3(0, 1, 0);

export class Blaster {
  /**
   * @param {import('./Weapons.js').Projeteis} projeteis
   */
  constructor(projeteis) {
    this.projeteis = projeteis;

    /** 0 = frio, 1 = no teto. */
    this.calor = 0;
    this.travado = false;
    this._recarga = 0;
    this._recargaGranada = 0;
    this._esperaFrio = 0;

    /** Dano por tiro, em pontos (ver `Vitals.js`: valores absolutos). */
    this.dano = 11;
    this.danoGranada = 46;

    /** @type {(() => void) | null} avisos para áudio e coice do modelo. */
    this.aoDisparar = null;
    this.aoTravar = null;
  }

  get sobreaquecido() {
    return this.travado;
  }

  /**
   * Tenta o tiro primário. Chame enquanto o botão estiver pressionado.
   *
   * @param {THREE.Vector3} olho
   * @param {THREE.Vector3} direcao normalizada
   * @param {any} dono
   * @returns {boolean} houve disparo neste quadro
   */
  primario(olho, direcao, dono) {
    if (this.travado || this._recarga > 0) return false;

    this._recarga = CADENCIA;
    this.calor = Math.min(1, this.calor + CALOR_POR_TIRO);
    this._esperaFrio = ESPERA_RESFRIAMENTO;

    if (this.calor >= 1) {
      this.travado = true;
      this.aoTravar?.();
    }

    // A ORDEM É OBRIGATÓRIA: a boca primeiro, porque a direção do tiro é
    // calculada A PARTIR dela (ver `_visar`).
    const boca = this._boca(olho, direcao);
    this.projeteis.disparar({
      origem: boca,
      direcao: this._visar(boca, olho, direcao),
      velocidade: 210,
      dano: this.dano,
      alcance: 400,
      cor: 0x9ef0ff,
      dono,
    });

    this.aoDisparar?.();
    return true;
  }

  /**
   * Granada de plasma. Explode ao encostar no chão e abre cratera.
   *
   * Mais lenta e com gravidade zero: é um projétil balístico só na aparência.
   * Dar-lhe queda real exigiria integrar gravidade radial por quadro e tornaria
   * a mira impossível de ensinar — o jogador não tem retículo balístico.
   */
  secundario(olho, direcao, dono) {
    if (this._recargaGranada > 0) return false;
    this._recargaGranada = CADENCIA_GRANADA;

    this.projeteis.disparar({
      origem: this._boca(olho, direcao),
      direcao,
      velocidade: 62,
      dano: 0,
      alcance: 180,
      cor: 0xff9a3c,
      dono,
      tipo: 'granada',
      explosao: {
        raio: 7.5,
        dano: this.danoGranada,
        /**
         * Profundidade da cratera, em unidades.
         *
         * Negativa: o campo de edições soma, então cavar é somar negativo (ver
         * `Terraform.esculpir`, que usa o mesmo sinal).
         */
        cratera: -2.6,
        raioCratera: 5.5,
      },
    });

    this.aoDisparar?.();
    return true;
  }

  /**
   * Ponto de saída do tiro.
   *
   * Não é o olho: o traçante nascendo no centro exato da tela some no primeiro
   * quadro (está dentro do plano próximo) e o jogador não vê disparo nenhum.
   * Descolado para baixo e para a direita, ele nasce onde a arma está na mão.
   */
  _boca(olho, direcao) {
    _lado.crossVectors(direcao, _acima);
    if (_lado.lengthSq() < 1e-6) _lado.set(1, 0, 0);
    _lado.normalize();
    _cima.crossVectors(_lado, direcao).normalize();
    return _origem
      .copy(olho)
      .addScaledVector(direcao, 0.7)
      .addScaledVector(_lado, DESLOCAMENTO_BOCA)
      .addScaledVector(_cima, -DESLOCAMENTO_BOCA * 0.62);
  }

  /**
   * Direção do tiro: da BOCA até o ponto de convergência da mira.
   *
   * =======================================================================
   * O DEFEITO QUE ISTO CONSERTA
   * =======================================================================
   * A primeira versão atirava da boca da arma ao longo do eixo do OLHAR. Em
   * primeira pessoa isso torna o traçante literalmente invisível: o tiro se
   * afasta na exata direção em que a câmera aponta, então é visto de topo, e
   * nove disparos escalonados projetavam todos no mesmo pixel — o centro do
   * retículo. Confirmei projetando as posições na tela: (638, 360) para os
   * nove, num alvo de 1280×720.
   *
   * Mirando num ponto à frente, o tiro sai na diagonal, cruza o campo de visão
   * nos primeiros metros e SÓ ENTÃO converge para o retículo. É o que dá o
   * risco de luz atravessando a tela, e é como todo jogo de tiro faz.
   *
   * A convergência também tem consequência de jogabilidade: alvos mais perto
   * que ela são atingidos ligeiramente ao lado do retículo, o que é o
   * comportamento real de uma arma cujo cano não está no olho.
   */
  _visar(boca, olho, direcao) {
    _mira.copy(olho).addScaledVector(direcao, CONVERGENCIA).sub(boca).normalize();

    // Dispersão dentro de um cone estreito. Existe pela razão oposta à
    // intuitiva: não é para dificultar, é para que uma rajada contínua não
    // desenhe UMA linha reta perfeita. Com dispersão zero os traçantes se
    // sobrepõem exatamente e a rajada parece um feixe parado.
    _lado.crossVectors(_mira, _acima);
    if (_lado.lengthSq() < 1e-6) _lado.set(1, 0, 0);
    _lado.normalize();
    _cima.crossVectors(_lado, _mira).normalize();

    const angulo = Math.random() * Math.PI * 2;
    // Raiz do sorteio: sem ela os tiros se concentram no centro do cone, porque
    // a área cresce com o quadrado do raio.
    const raio = Math.sqrt(Math.random()) * DISPERSAO;
    return _dir
      .copy(_mira)
      .addScaledVector(_lado, Math.cos(angulo) * raio)
      .addScaledVector(_cima, Math.sin(angulo) * raio)
      .normalize();
  }

  atualizar(dt) {
    if (this._recarga > 0) this._recarga -= dt;
    if (this._recargaGranada > 0) this._recargaGranada -= dt;

    if (this._esperaFrio > 0) {
      this._esperaFrio -= dt;
      return;
    }

    if (this.calor > 0) {
      this.calor = Math.max(0, this.calor - RESFRIAMENTO * dt);
      if (this.travado && this.calor <= LIMIAR_DESTRAVA) this.travado = false;
    }
  }
}
