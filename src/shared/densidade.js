/**
 * Campo de densidade: a base do terreno volumétrico.
 *
 * ===========================================================================
 * O QUE MUDA, E POR QUE ISTO É UMA PONTE E NÃO UMA RUPTURA
 * ===========================================================================
 * O terreno atual é um CAMPO DE ALTURA: `heightAt(direção)` devolve UM número,
 * então para cada direção saindo do centro existe exatamente um ponto de
 * superfície. É por isso que caverna é impossível ali — dentro de uma, olhando
 * para cima, há teto acima e chão abaixo na MESMA direção, e nenhum número
 * único representa os dois.
 *
 * Um campo de densidade responde outra pergunta: dado um ponto do espaço, ele
 * está dentro ou fora da rocha? A superfície é onde a resposta cruza zero, e
 * nada impede que um raio cruze zero várias vezes. Caverna passa a ser possível
 * por construção.
 *
 * ===========================================================================
 * A PONTE
 * ===========================================================================
 * A densidade base é definida como:
 *
 *     d(p) = |p| - (raio + heightAt(p/|p|))
 *
 * Negativa dentro da rocha, positiva no ar, zero exatamente na superfície que o
 * jogo desenha hoje. Isto não é um detalhe de implementação — é a decisão que
 * torna a migração verificável:
 *
 *   - o mesher novo pode ser EXIGIDO a reproduzir o terreno atual antes de
 *     ganhar qualquer feição tridimensional;
 *   - qualquer divergência entre o mundo velho e o novo é um defeito do mesher,
 *     não uma mudança de conteúdo;
 *   - todo o trabalho já feito de continentes, cordilheiras, crateras, cânions,
 *     biomas e paleta continua valendo, sem reescrever nada.
 *
 * As cavernas entram DEPOIS, como um termo que só age abaixo da superfície.
 *
 * ===========================================================================
 * POR QUE NÃO É UMA DISTÂNCIA COM SINAL DE VERDADE
 * ===========================================================================
 * `|p| - superfície` é a distância radial até a superfície, não a distância
 * mínima. Numa encosta íngreme ela superestima — o ponto mais próximo da rocha
 * não está na vertical. Isso importa para duas coisas:
 *
 *   1. a interpolação do marching cubes fica ligeiramente enviesada em paredes
 *      quase verticais (o vértice sai um pouco fora do lugar);
 *   2. não dá para usar este campo para marcha de esfera (sphere tracing) sem
 *      um fator de segurança.
 *
 * Nenhuma das duas impede o mesher, e a alternativa — calcular distância
 * mínima real a um campo de altura arbitrário — não tem forma fechada. É a
 * mesma aproximação que praticamente todo terreno volumétrico usa.
 */

import { createNoise3D, fbm, smoothstep, clamp } from './noise.js';

/**
 * Cria o campo de densidade de um planeta.
 *
 * @param {object} cfg config do planeta (`createPlanetConfig`)
 * @param {(x:number,y:number,z:number)=>number} heightAt o amostrador de altura
 *   existente, já com as escavações aplicadas
 */
export function criarCampoDeDensidade(cfg, heightAt) {
  const raio = cfg.radius;

  // Campos próprios das cavernas, com offsets que não colidem com os de
  // `terrain.js` — dois campos correlacionados fariam a caverna nascer sempre
  // sob a mesma feição do relevo.
  const nTunel = createNoise3D((cfg.seed + 8191) >>> 0);
  const nTunel2 = createNoise3D((cfg.seed + 8419) >>> 0);
  const nCamara = createNoise3D((cfg.seed + 9203) >>> 0);
  const nBoca = createNoise3D((cfg.seed + 10357) >>> 0);

  const C = cfg.cavernas ?? PADRAO_CAVERNAS;

  /**
   * Altura da superfície numa direção. Extraída para que o mesher possa
   * consultá-la sem recalcular a densidade inteira.
   */
  function superficieEm(nx, ny, nz) {
    return raio + heightAt(nx, ny, nz);
  }

  /**
   * Túneis por ruído em folha dupla.
   *
   * ---------------------------------------------------------------------
   * POR QUE DOIS CAMPOS MULTIPLICADOS, E NÃO UM
   * ---------------------------------------------------------------------
   * O truque padrão é |ruído| < limiar, que devolve a região perto da
   * superfície de nível zero — uma FOLHA, não um túnel. Em três dimensões
   * isso produz lençóis de vazio, como se alguém tivesse fatiado a rocha.
   *
   * A interseção de DUAS folhas independentes é uma curva: é isso que dá
   * túnel. O custo é uma avaliação de ruído a mais, e é a diferença entre uma
   * caverna e uma rachadura plana atravessando o planeta inteiro.
   */
  function tuneis(x, y, z) {
    const f = C.freqTunel;
    const a = fbm(nTunel, x * f, y * f, z * f, 2, 1, 0.5, 2.0);
    const b = fbm(nTunel2, x * f, y * f, z * f, 2, 1, 0.5, 2.0);
    // Cada folha vale 1 no centro e 0 na borda; o produto só é alto onde as
    // duas coincidem.
    const folhaA = 1 - smoothstep(0, C.espessura, Math.abs(a));
    const folhaB = 1 - smoothstep(0, C.espessura, Math.abs(b));
    return folhaA * folhaB;
  }

  /**
   * Intensidade da BOCA de caverna no ponto: 0 = teto selado, 1 = aberto.
   *
   * Frequência baixa e limiar alto: a boca precisa ser rara (para valer a pena
   * procurar) e contígua (para ser uma abertura e não um crivo). O `smoothstep`
   * estreito é o que dá borda de cratera em vez de um desvanecimento de
   * quilômetros.
   */
  function intensidadeDaBoca(x, y, z) {
    const f = C.freqBoca;
    const v = nBoca(x * f, y * f, z * f);
    return smoothstep(C.limiarBoca, C.limiarBoca + 0.12, v);
  }

  /** Câmaras: bolsões grandes, esparsos, que dão à caverna lugares "de parar". */
  function camaras(x, y, z) {
    const f = C.freqCamara;
    const v = nCamara(x * f, y * f, z * f);
    return smoothstep(C.limiarCamara, 1.0, v);
  }

  /**
   * Densidade no ponto. Negativa = rocha, positiva = ar.
   *
   * @param {number} x coordenada LOCAL ao planeta (centro na origem)
   */
  function densidadeEm(x, y, z) {
    const dist = Math.hypot(x, y, z);
    if (dist < 1e-6) return -raio; // centro do planeta: rocha maciça
    const inv = 1 / dist;
    return densidadeComAltura(x, y, z, superficieEm(x * inv, y * inv, z * inv), dist);
  }

  /**
   * A mesma densidade, com a altura da superfície JÁ CALCULADA.
   *
   * =======================================================================
   * ESTA É A FUNÇÃO QUE TORNA O TERRENO VOLUMÉTRICO VIÁVEL
   * =======================================================================
   * `superficieEm` chama `heightAt`, que custa 0,88 µs — são ~20 oitavas de
   * ruído. Numa grade de 33 mil amostras isso são 29 ms só de altura, por
   * chunk, e o orçamento de um quadro inteiro é 16 ms.
   *
   * Mas a altura da superfície depende SÓ DA DIREÇÃO. Numa grade esférica
   * todas as amostras de uma mesma coluna radial compartilham a direção, então
   * quem malha o chunk pode calcular a altura uma vez por coluna e passá-la
   * aqui. Em números medidos: 1.225 chamadas em vez de 33.075.
   *
   * Eu já tinha montado essa tabela em `chunkVolumetrico.js` e continuava
   * chamando `densidadeEm`, que recalculava tudo — a otimização existia no
   * papel e o chunk levava 47 ms.
   *
   * @param {number} alturaSuperficie raio da superfície NESTA direção
   * @param {number} [dist] `|p|`, se quem chama já o tiver
   */
  function densidadeComAltura(x, y, z, alturaSuperficie, dist) {
    if (dist === undefined) dist = Math.hypot(x, y, z);

    // Positivo fora, negativo dentro.
    let d = dist - alturaSuperficie;

    if (!C.ligadas) return d;

    // -------------------------------------------------------------------
    // AS CAVERNAS SÓ AGEM ABAIXO DA SUPERFÍCIE, E COM DUAS MARGENS.
    //
    // `teto` impede que um túnel aflore e abra buracos aleatórios no chão —
    // que, além de feio, deixaria o jogador cair em fendas invisíveis vindas
    // de nada. `piso` impede que a rede de túneis chegue ao núcleo e
    // dissolva o planeta por dentro.
    //
    // As entradas de caverna passam a ser uma decisão explícita (um túnel
    // que sobe até a margem numa região escolhida), e não um acidente do
    // ruído — que é o que se quer: entrada de caverna é conteúdo.
    // -------------------------------------------------------------------
    const profundidade = alturaSuperficie - dist;
    if (profundidade <= 0) return d;

    // -------------------------------------------------------------------
    // BOCAS: onde a margem de teto é suspensa, a caverna aflora.
    //
    // Sem isto as cavernas são habitáveis e inalcançáveis — `margemTeto` sela
    // o teto em toda parte, de propósito, para que o ruído não abra fendas
    // aleatórias sob os pés do jogador.
    //
    // A boca é um campo de baixa frequência com limiar alto: raro, contíguo, e
    // do tamanho de uma cratera. Onde ele é forte, a margem de teto vai a zero
    // e o túnel sobe até a superfície; onde é fraco, nada muda. É o que faz da
    // entrada uma FEIÇÃO DO MAPA — algo que se procura e se reconhece de longe
    // — em vez de um buraco que aparece por acidente.
    // -------------------------------------------------------------------
    const boca = C.bocas ? intensidadeDaBoca(x, y, z) : 0;
    const margemTeto = C.margemTeto * (1 - boca);

    const abertura =
      smoothstep(0, Math.max(0.5, margemTeto), profundidade) *
      (1 - smoothstep(C.profundidadeMaxima - C.margemPiso, C.profundidadeMaxima, profundidade));
    if (abertura <= 0) return d;

    const vazio = clamp(tuneis(x, y, z) + camaras(x, y, z) * C.pesoCamara, 0, 1);

    // -------------------------------------------------------------------
    // SUBTRAÇÃO BOOLEANA, E NÃO SOMA. O PORQUÊ CUSTOU UMA MEDIÇÃO.
    //
    // A primeira versão fazia `d += vazio * abertura * forca`. Parece razoável
    // e é estruturalmente errado: `d` é uma distância. A 150 unidades de
    // profundidade ele vale -150, e somar `forca` (26) devolve -124 — ainda
    // rocha maciça. A escavação só vencia onde a profundidade era menor que a
    // força, isto é, exatamente na faixa que `margemTeto` já suprimia.
    //
    // O sintoma foi medido, não visto: 0,16% de vazio no subsolo, e
    // praticamente insensível à espessura do túnel — que é a assinatura de um
    // parâmetro que não está no caminho crítico.
    //
    // O certo é tratar a caverna como um SÓLIDO PRÓPRIO e subtraí-la do
    // terreno, que é a operação CSG de sempre: `max(terreno, cavidade)`. Assim
    // a cavidade vale por si, independentemente de quão fundo está.
    // -------------------------------------------------------------------
    const cavidade = (vazio - C.limiarVazio) * C.escala;
    const comCaverna = Math.max(d, cavidade);

    // A interpolação pela abertura vai entre "sem caverna" e "com caverna", e
    // não sobre o valor da cavidade. Multiplicar a cavidade pela abertura
    // deixaria `max(d, 0)` nas margens — ou seja, ar em toda parte.
    return d + (comCaverna - d) * abertura;
  }

  return { densidadeEm, densidadeComAltura, superficieEm, raio };
}

/**
 * Parâmetros de caverna.
 *
 * Ficam aqui, e não em `PlanetConfig.js`, enquanto o volumétrico é
 * experimental: acrescentar campos à config do planeta mexe no fluxo de sorteio
 * do gerador e mudaria TODOS os planetas existentes — o mesmo engano que já
 * aconteceu ao inserir parâmetros no meio da lista de `between()`.
 */
export const PADRAO_CAVERNAS = {
  ligadas: true,
  /** Frequência dos túneis. Menor = túneis mais longos e largos. */
  freqTunel: 0.0022,
  /** Meia-espessura da folha de ruído. Maior = túnel mais gordo. */
  espessura: 0.14,
  freqCamara: 0.0009,
  limiarCamara: 0.62,
  pesoCamara: 0.8,
  /**
   * Acima deste valor de `vazio` há cavidade. Governa quão RARA ela é.
   */
  limiarVazio: 0.42,
  /**
   * Converte o campo de cavidade (adimensional) em unidades de mundo.
   *
   * É o raio típico do túnel: com 22, o centro da cavidade fica ~13 unidades
   * "dentro do ar", o que dá um vão que uma pessoa atravessa em pé.
   */
  escala: 22,
  /** Rocha sólida preservada logo abaixo da superfície, em unidades. */
  margemTeto: 26,

  /** Bocas de caverna: onde a margem de teto é suspensa e o túnel aflora. */
  bocas: true,
  /** Frequência do campo de bocas. Menor = bocas mais raras e maiores. */
  freqBoca: 0.0016,
  /**
   * Limiar acima do qual há boca.
   *
   * Alto de propósito. Uma entrada de caverna deve ser algo que se PROCURA e se
   * reconhece de longe; abaixar isto transforma a superfície num queijo e tira
   * o valor de ter encontrado uma.
   */
  limiarBoca: 0.55,
  /** Até onde a rede desce, em unidades abaixo da superfície. */
  profundidadeMaxima: 420,
  margemPiso: 120,
};
