/**
 * Escudo e blindagem — o núcleo compartilhado do combate.
 *
 * ===========================================================================
 * POR QUE ISTO É UMA CLASSE NEUTRA, E NÃO UM CAMPO NO JOGADOR
 * ===========================================================================
 * Quem leva dano neste jogo vai ser, no mínimo: o jogador a pé, a nave, os
 * drones sentinelas, a fauna predadora, as torretas e os geradores de escudo da
 * base. Se a conta de "quanto do golpe o escudo absorve e quando ele volta"
 * morasse dentro do `PlayerController`, cada um desses seis a reimplementaria
 * com uma variação sutil — e a variação sutil em regra de combate é como se
 * produz um jogo em que atirar em duas coisas parecidas dá resultados
 * diferentes sem motivo.
 *
 * Então isto não sabe o que é um jogador, uma nave ou um drone. Sabe absorver
 * dano, regenerar e morrer. Quem for atacável tem uma instância.
 *
 * ===========================================================================
 * A REGRA
 * ===========================================================================
 *   - O escudo absorve o dano PRIMEIRO, e integralmente. Só o que sobra depois
 *     de zerá-lo atinge a blindagem.
 *   - O escudo volta sozinho, mas só depois de um tempo SEM LEVAR DANO. É esse
 *     atraso, e não a taxa, que define o ritmo do combate: ele é o que obriga a
 *     quebrar contato em vez de trocar tiros parado.
 *   - A blindagem NÃO volta sozinha. Recuperá-la custa item (Ferrite, Carbono).
 *     Se ela também regenerasse, o escudo perderia a função e todo combate
 *     viraria uma questão de esperar.
 *
 * ===========================================================================
 * ABSOLUTO, NÃO NORMALIZADO
 * ===========================================================================
 * Os valores são pontos, não frações. É deliberado: um drone com 40 de escudo e
 * um jogador com 100 precisam sofrer o mesmo com uma arma que tira 25, e isso só
 * funciona se a arma falar em pontos. As frações que a interface consome saem
 * de `razaoEscudo` / `razaoVida`.
 */

/** Segundos sem levar dano antes de o escudo começar a voltar. */
const ESPERA_REGENERACAO = 5;

/**
 * Fração do escudo máximo recuperada por segundo, uma vez iniciada.
 *
 * Um terço por segundo: três segundos do zero ao cheio. Cheio o bastante para
 * premiar quem rompe contato, lento o bastante para que fugir a meio caminho
 * não devolva um escudo inteiro antes do próximo tiro.
 */
const TAXA_REGENERACAO = 1 / 3;

export class Vitais {
  /**
   * @param {object} opcoes
   * @param {number} [opcoes.escudoMaximo]
   * @param {number} [opcoes.vidaMaxima]
   * @param {boolean} [opcoes.invulneravel] zonas seguras, cinemáticas, depuração
   */
  constructor({ escudoMaximo = 100, vidaMaxima = 100, invulneravel = false } = {}) {
    this.escudoMaximo = escudoMaximo;
    this.vidaMaxima = vidaMaxima;
    this.escudo = escudoMaximo;
    this.vida = vidaMaxima;
    this.invulneravel = invulneravel;

    /** Segundos que faltam para o escudo voltar a subir. */
    this.esperaRegeneracao = 0;

    /**
     * Quanto tempo faz que este alvo levou dano, em segundos.
     *
     * Serve a quem PRECISA saber que houve combate agora: a interface pisca a
     * barra, o áudio toca o impacto, a IA decide perseguir. Sem isto cada um
     * desses guardaria seu próprio relógio a partir do callback, e eles
     * divergiriam.
     */
    this.desdeUltimoDano = Infinity;

    this.vivo = true;

    /** @type {((dano: {escudo: number, vida: number, origem: any}) => void) | null} */
    this.aoLevarDano = null;
    /** @type {((origem: any) => void) | null} */
    this.aoMorrer = null;
    /** @type {(() => void) | null} */
    this.aoQuebrarEscudo = null;
  }

  get razaoEscudo() {
    return this.escudoMaximo > 0 ? this.escudo / this.escudoMaximo : 0;
  }

  get razaoVida() {
    return this.vidaMaxima > 0 ? this.vida / this.vidaMaxima : 0;
  }

  /** O escudo está subindo neste instante? (a interface o desenha diferente) */
  get regenerando() {
    return this.vivo && this.esperaRegeneracao <= 0 && this.escudo < this.escudoMaximo;
  }

  /**
   * Aplica dano e devolve quanto foi absorvido por cada camada.
   *
   * O retorno é detalhado de propósito: quem atira precisa saber se o golpe
   * bateu no escudo ou na blindagem para escolher o efeito visual — faísca azul
   * contra fagulha e fumaça —, e essa informação só existe aqui dentro.
   *
   * @param {number} quantidade pontos de dano
   * @param {any} [origem] quem causou (para atribuição, aggro e placar)
   * @returns {{escudo: number, vida: number, letal: boolean}}
   */
  aplicarDano(quantidade, origem = null) {
    if (!this.vivo || this.invulneravel || !(quantidade > 0)) {
      return { escudo: 0, vida: 0, letal: false };
    }

    // O relógio reinicia mesmo que o golpe seja inteiramente absorvido: levar um
    // tiro no escudo cheio ainda é estar em combate, e adiar a regeneração é
    // justamente o que faz o fogo de supressão significar alguma coisa.
    this.esperaRegeneracao = ESPERA_REGENERACAO;
    this.desdeUltimoDano = 0;

    const noEscudo = Math.min(this.escudo, quantidade);
    this.escudo -= noEscudo;
    const restante = quantidade - noEscudo;

    const naVida = Math.min(this.vida, restante);
    this.vida -= naVida;

    if (noEscudo > 0 && this.escudo <= 0) this.aoQuebrarEscudo?.();

    const resultado = { escudo: noEscudo, vida: naVida, letal: this.vida <= 0 };
    this.aoLevarDano?.({ ...resultado, origem });

    if (resultado.letal) {
      this.vivo = false;
      this.aoMorrer?.(origem);
    }
    return resultado;
  }

  /** Recupera blindagem (item de cura). Não toca no escudo. */
  curar(quantidade) {
    if (!this.vivo) return 0;
    const antes = this.vida;
    this.vida = Math.min(this.vidaMaxima, this.vida + Math.max(0, quantidade));
    return this.vida - antes;
  }

  /** Recarga manual de escudo (item), ignorando a espera. */
  recarregarEscudo(quantidade) {
    if (!this.vivo) return 0;
    const antes = this.escudo;
    this.escudo = Math.min(this.escudoMaximo, this.escudo + Math.max(0, quantidade));
    return this.escudo - antes;
  }

  /** Volta ao estado inicial (renascer, entrar em zona segura, novo sistema). */
  restaurar() {
    this.escudo = this.escudoMaximo;
    this.vida = this.vidaMaxima;
    this.esperaRegeneracao = 0;
    this.desdeUltimoDano = Infinity;
    this.vivo = true;
  }

  /**
   * @param {number} dt segundos
   */
  atualizar(dt) {
    if (!this.vivo) return;

    if (this.desdeUltimoDano !== Infinity) this.desdeUltimoDano += dt;

    if (this.esperaRegeneracao > 0) {
      this.esperaRegeneracao -= dt;
      // Sem `return` aqui de propósito: quando a espera termina no MEIO de um
      // quadro, o resto do quadro já regenera. Cortar fora empurraria o início
      // da regeneração para o quadro seguinte, o que a 15 fps é um erro
      // visível justamente para quem tem a máquina mais fraca.
      if (this.esperaRegeneracao > 0) return;
      dt = -this.esperaRegeneracao;
      this.esperaRegeneracao = 0;
    }

    if (this.escudo < this.escudoMaximo) {
      this.escudo = Math.min(
        this.escudoMaximo,
        this.escudo + this.escudoMaximo * TAXA_REGENERACAO * dt
      );
    }
  }
}
