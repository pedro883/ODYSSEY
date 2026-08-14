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

      if ((vA <= 0) !== (vB <= 0)) {
        // Bisseção no intervalo que trocou de sinal.
        let lo = rA, hi = rB, vLo = vA;
        for (let k = 0; k < bisseccoes; k++) {
          const meio = (lo + hi) * 0.5;
          const vMeio = amostra(dir, meio, altura);
          if ((vLo <= 0) !== (vMeio <= 0)) hi = meio;
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

  /** O ponto está dentro da rocha? */
  function solidoEm(dir, raio) {
    return amostra(dir, raio, campo.superficieEm(dir[0], dir[1], dir[2])) <= 0;
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
