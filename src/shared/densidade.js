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
    const alturaSuperficie = superficieEm(x * inv, y * inv, z * inv);

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

    const abertura =
      smoothstep(0, C.margemTeto, profundidade) *
      (1 - smoothstep(C.profundidadeMaxima - C.margemPiso, C.profundidadeMaxima, profundidade));
    if (abertura <= 0) return d;

    const vazio = clamp(tuneis(x, y, z) + camaras(x, y, z) * C.pesoCamara, 0, 1);

    // A escavação SOMA densidade (empurra para o positivo, isto é, para o ar).
    // Multiplicada pela abertura, ela desaparece suavemente nas duas margens em
    // vez de terminar num degrau — degrau em campo de densidade vira parede
    // perfeitamente plana no mesher, e o olho identifica isso na hora.
    d += vazio * abertura * C.forca;
    return d;
  }

  return { densidadeEm, superficieEm, raio };
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
  /** Quanto de densidade a escavação soma no pico. */
  forca: 26,
  /** Rocha sólida preservada logo abaixo da superfície, em unidades. */
  margemTeto: 26,
  /** Até onde a rede desce, em unidades abaixo da superfície. */
  profundidadeMaxima: 420,
  margemPiso: 120,
};
