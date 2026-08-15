/**
 * Sonda do campo de densidade: as perguntas que a colisão precisa fazer.
 *
 * ===========================================================================
 * O PROBLEMA
 * ===========================================================================
 * Com campo de altura, "onde está o chão sob mim?" é UMA amostra: a superfície
 * está em `raio + heightAt(direção)`, ponto final. É por isso que `sampleAt()`
 * é barato e pode ser chamado pela nave, pelo jogador, por cada criatura e por
 * cada projétil, todo quadro.
 *
 * Com campo de densidade a pergunta deixa de ter resposta fechada. A superfície
 * é onde a densidade cruza zero, e ao longo de um raio isso pode acontecer
 * várias vezes — que é justamente o que torna caverna possível. Só resta
 * procurar: marchar ao longo do raio até o sinal mudar.
 *
 * ===========================================================================
 * A PROPRIEDADE QUE TORNA ISSO BARATO
 * ===========================================================================
 * Marchar parece caro: cada amostra custaria os 0,88 µs de `heightAt`, e cem
 * amostras por entidade por quadro acabariam com o orçamento.
 *
 * Mas a marcha da colisão é RADIAL — de onde o corpo está em direção ao centro
 * do planeta, ou dele para cima. Ao longo de um raio a DIREÇÃO não muda, e a
 * altura da superfície depende só da direção. Então `heightAt` é avaliado UMA
 * VEZ por marcha, e as dezenas de amostras seguintes reaproveitam o valor via
 * `densidadeComAltura`.
 *
 * É a mesma propriedade que tornou o chunk viável (ver `chunkVolumetrico.js`),
 * aplicada de novo. Uma marcha de 60 passos custa uma avaliação cara mais 60
 * baratas, e não 60 caras.
 *
 * ===========================================================================
 * REFINAMENTO POR BISSEÇÃO
 * ===========================================================================
 * A marcha acha o INTERVALO onde o sinal virou; o cruzamento fica em algum
 * ponto dele. Parar aí deixaria a colisão com a granularidade do passo — o
 * jogador afundaria ou flutuaria até meio passo. Algumas bissecções custam
 * quase nada (são amostras baratas) e levam o erro para a casa do centímetro.
 */

/**
 * Quanto a sonda procura para CIMA quando o ponto está dentro da rocha.
 *
 * Curto: serve para desenterrar quem afundou uma fração no piso, não para
 * resgatar quem está soterrado a cinquenta metros — nesse caso não existe piso
 * local e a resposta do campo de altura é a sensata.
 */
const SUBIDA_MAXIMA = 12;

/**
 * @param {{densidadeComAltura:Function, superficieEm:Function, raio:number}} campo
 */
export function criarSonda(campo) {
  /**
   * Primeiro cruzamento ao longo de um RAIO radial.
   *
   * @param {number[]} dir direção unitária a partir do centro do planeta
   * @param {number} rDe raio inicial da busca
   * @param {number} rAte raio final (pode ser menor que `rDe`: busca para baixo)
   * @param {number} passo tamanho do passo, em unidades
   * @param {number} [bisseccoes]
   * @returns {number|null} raio do cruzamento, ou null se não houver
   */
  function cruzamentoRadial(dir, rDe, rAte, passo, bisseccoes = 12) {
    // A conta cara, UMA vez para a marcha inteira.
    const altura = campo.superficieEm(dir[0], dir[1], dir[2]);

    const desce = rAte < rDe;
    const d = desce ? -Math.abs(passo) : Math.abs(passo);
    const n = Math.ceil(Math.abs(rAte - rDe) / Math.abs(passo));

    let rA = rDe;
    let vA = amostra(dir, rA, altura);

    for (let i = 1; i <= n; i++) {
      const rB = rDe + d * i;
      const vB = amostra(dir, rB, altura);

      if ((vA < 0) !== (vB < 0)) {
        // Bisseção no intervalo que trocou de sinal.
        let lo = rA, hi = rB, vLo = vA;
        for (let k = 0; k < bisseccoes; k++) {
          const meio = (lo + hi) * 0.5;
          const vMeio = amostra(dir, meio, altura);
          if ((vLo < 0) !== (vMeio < 0)) hi = meio;
          else { lo = meio; vLo = vMeio; }
        }
        return (lo + hi) * 0.5;
      }
      rA = rB;
      vA = vB;
    }
    return null;
  }

  function amostra(dir, raio, altura) {
    return campo.densidadeComAltura(dir[0] * raio, dir[1] * raio, dir[2] * raio, altura, raio);
  }

  /**
   * O ponto está dentro da rocha?
   *
   * ESTRITAMENTE menor que zero, igual ao mesher (`marchingCubes.js` liga o bit
   * do caso com `< 0`). A sonda usava `<= 0` e as duas convenções divergiam
   * exatamente no ponto da superfície, onde a densidade vale zero por
   * construção.
   *
   * O efeito era uma TAMPA de espessura nula sobre cada boca de caverna: o
   * perfil media +0,50 acima, 0,000 na superfície e +1,70 logo abaixo — ou
   * seja, ar dos dois lados de um único ponto tratado como rocha. A marcha da
   * colisão parava nele e o jogador andava por cima do buraco.
   */
  function solidoEm(dir, raio) {
    return amostra(dir, raio, campo.superficieEm(dir[0], dir[1], dir[2])) < 0;
  }

  /**
   * O chão sob uma posição.
   *
   * Devolve o raio da primeira superfície ABAIXO, que é o que a colisão precisa
   * — e o que, numa caverna, é o piso da caverna e não o topo da montanha.
   *
   * @param {number[]} dir direção unitária
   * @param {number} raio raio atual do corpo
   * @param {number} alcance até onde procurar, em unidades
   */
  function chaoAbaixo(dir, raio, alcance = 400) {
    // -----------------------------------------------------------------------
    // SE O PONTO JÁ ESTÁ NA ROCHA, NÃO HÁ CHÃO ABAIXO DELE.
    //
    // Esta guarda é a correção de um bug que fazia o jogador ATRAVESSAR o chão.
    // `cruzamentoRadial` devolve a primeira troca de sinal, seja ela qual for.
    // Partindo de dentro da rocha, a primeira troca descendo é rocha->ar: o
    // TETO de uma caverna, dezenas de unidades abaixo. O jogo lia isso como "o
    // chão está lá embaixo" e deixava o jogador cair.
    //
    // E o caso não era raro: um corpo parado no chão fica ligeiramente ABAIXO
    // da superfície (é assim que a colisão o assenta), portanto dentro da
    // rocha. Medido, 27% das posições de chão devolviam um piso falso — uma a
    // cada quatro.
    //
    // Devolver `null` faz `Planet.sampleAt` manter a resposta do campo de
    // altura, que é a certa: quem está dentro da rocha precisa ser empurrado
    // para CIMA, para a superfície, e não atraído para um vão lá embaixo.
    // -----------------------------------------------------------------------
    const altura = campo.superficieEm(dir[0], dir[1], dir[2]);

    if (amostra(dir, raio, altura) < 0) {
      // ---------------------------------------------------------------------
      // DENTRO DA ROCHA, O CHÃO ESTÁ ACIMA — E ACHÁ-LO É O QUE PERMITE FICAR
      // NUMA CAVERNA.
      //
      // Devolver `null` aqui parecia seguro (quem está enterrado é empurrado
      // para cima pelo campo de altura) e destruía o caso que mais importa: ao
      // POUSAR no piso de uma caverna o corpo afunda uma fração nele, porque é
      // assim que a colisão assenta. A sonda via rocha, devolvia null,
      // `sampleAt` caía de volta na superfície EXTERNA e o jogador era
      // teletransportado dezenas de unidades para cima.
      //
      // Medido numa boca real: a queda funcionava de +3 até -40, e a -44 —
      // meio metro dentro do piso — o chão devolvido saltava de -43 para 0.
      //
      // O certo é procurar a primeira superfície ACIMA: para quem afundou no
      // piso da caverna é o próprio piso, e para quem afundou no relevo é o
      // relevo. A busca é CURTA de propósito: se o corpo está fundo demais na
      // rocha, não há piso local nenhum e o campo de altura volta a ser a
      // resposta sensata.
      // ---------------------------------------------------------------------
      return cruzamentoRadial(dir, raio, raio + SUBIDA_MAXIMA, 0.5);
    }

    return cruzamentoRadial(dir, raio, raio - alcance, 2.0);
  }

  /**
   * O teto acima, se houver. `null` significa céu aberto.
   *
   * É o que distingue "estou numa caverna" de "estou ao ar livre", e o que a
   * iluminação e o áudio vão precisar para saber que o jogador entrou.
   */
  function tetoAcima(dir, raio, alcance = 400) {
    return cruzamentoRadial(dir, raio, raio + alcance, 2.0);
  }

  return { cruzamentoRadial, chaoAbaixo, tetoAcima, solidoEm };
}
