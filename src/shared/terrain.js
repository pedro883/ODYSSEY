/**
 * Amostrador de terreno — o "DNA" do planeta.
 *
 * ESTE ARQUIVO É COMPARTILHADO entre a main thread e o Web Worker.
 * A main thread usa `heightAt()` para saber a altitude da nave e para posicionar
 * os nós da quadtree; o worker usa as mesmas funções para gerar a malha.
 * Como o campo de ruído é determinístico (derivado só do seed), os dois lados
 * concordam bit a bit — sem isso, a nave "afundaria" no terreno visível.
 *
 * Não importe Three.js aqui: workers não devem carregar a engine inteira.
 */

import { createNoise3D, fbm, ridged, smoothstep, clamp, lerp } from './noise.js';

/* =========================================================================
   Cube-sphere: as 6 faces do cubo que, normalizadas, viram a esfera.
   ========================================================================= */

/**
 * Cada face define uma base local (u, v, w) que É DEXTRÓGIRA: cross(u, v) = w,
 * com `w` apontando para fora do planeta. Isso garante que o mesmo index buffer
 * (winding CCW) produza faces frontais corretas nas 6 faces — sem isso metade
 * do planeta ficaria invisível por backface culling.
 */
export const CUBE_FACES = [
  { name: '+X', w: [1, 0, 0],  u: [0, 0, -1], v: [0, 1, 0] },
  { name: '-X', w: [-1, 0, 0], u: [0, 0, 1],  v: [0, 1, 0] },
  { name: '+Y', w: [0, 1, 0],  u: [1, 0, 0],  v: [0, 0, -1] },
  { name: '-Y', w: [0, -1, 0], u: [1, 0, 0],  v: [0, 0, 1] },
  { name: '+Z', w: [0, 0, 1],  u: [1, 0, 0],  v: [0, 1, 0] },
  { name: '-Z', w: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

/**
 * Converte (face, u, v) com u,v ∈ [0,1] numa direção unitária na esfera.
 *
 * Usa a projeção "spherified cube" em vez de normalizar direto: a normalização
 * simples concentra vértices nos cantos do cubo (quads até 40% menores lá),
 * o que faz o LOD ficar desigual. Esta fórmula distribui a área bem melhor.
 *
 * @param {Float32Array|number[]} out vetor de 3 posições
 */
export function faceDirection(face, u, v, out) {
  const F = CUBE_FACES[face];
  const a = u * 2 - 1;
  const b = v * 2 - 1;

  const x = F.w[0] + a * F.u[0] + b * F.v[0];
  const y = F.w[1] + a * F.u[1] + b * F.v[1];
  const z = F.w[2] + a * F.u[2] + b * F.v[2];

  const x2 = x * x;
  const y2 = y * y;
  const z2 = z * z;

  let sx = x * Math.sqrt(Math.max(0, 1 - y2 * 0.5 - z2 * 0.5 + (y2 * z2) / 3));
  let sy = y * Math.sqrt(Math.max(0, 1 - z2 * 0.5 - x2 * 0.5 + (z2 * x2) / 3));
  let sz = z * Math.sqrt(Math.max(0, 1 - x2 * 0.5 - y2 * 0.5 + (x2 * y2) / 3));

  // Renormaliza: os anéis de padding ficam fora de [-1,1] e a fórmula acima
  // só garante norma unitária exatamente sobre a superfície do cubo.
  const inv = 1 / Math.sqrt(sx * sx + sy * sy + sz * sz);
  out[0] = sx * inv;
  out[1] = sy * inv;
  out[2] = sz * inv;
  return out;
}

/* =========================================================================
   Amostrador
   ========================================================================= */

const BIOME_NAMES = {
  OCEAN: 'Oceano',
  BEACH: 'Litoral',
  GRASS: 'Planície',
  FOREST: 'Floresta',
  DESERT: 'Deserto',
  TUNDRA: 'Tundra',
  ROCK: 'Rochoso',
  SNOW: 'Glacial',
};

/**
 * @param {object} cfg saída de `createPlanetConfig()` — precisa ser um objeto
 *   serializável (structured-clone) porque atravessa a fronteira do worker.
 */
export function createTerrainSampler(cfg, campoInicial = null) {
  const seed = cfg.seed;

  /**
   * Camada de escavações por cima do ruído (`shared/edits.js`).
   *
   * Fica numa variável mutável, e não num parâmetro fixo, porque o worker troca
   * o campo por um RECORTE da região antes de gerar cada chunk — ver
   * `CampoDeEdicoes.paraRegiao`. O amostrador não precisa saber disso; só sabe
   * que existe um campo e que ele pode mudar entre chamadas.
   */
  let campo = campoInicial;

  // Campos de ruído independentes. Offsets primos evitam correlação visível
  // entre eles (dois campos correlacionados fazem montanha sempre nascer
  // no mesmo lugar que o deserto, e o planeta fica com cara de "listrado").
  const nContinent = createNoise3D(seed + 13);
  const nMountain = createNoise3D(seed + 91);
  const nDetail = createNoise3D(seed + 421);
  const nWarp = createNoise3D(seed + 777);
  const nMoisture = createNoise3D(seed + 1213);
  const nCrater = createNoise3D(seed + 3301);
  const nTemp = createNoise3D(seed + 5077);

  const P = cfg.terrain;
  const pal = cfg.palette;

  // Buffers reaproveitados — evita alocar dentro do loop de milhares de vértices.
  const warped = [0, 0, 0];

  /** Domain warping: distorce as coordenadas antes de amostrar. */
  function warp(x, y, z) {
    const f = P.warpFreq;
    const s = P.warpStrength;
    warped[0] = x + s * nWarp(x * f, y * f, z * f);
    warped[1] = y + s * nWarp(x * f + 31.4, y * f + 7.7, z * f + 19.2);
    warped[2] = z + s * nWarp(x * f - 12.1, y * f - 45.3, z * f + 3.9);
    return warped;
  }

  /** Perfil de cratera: bacia rebaixada + anel de borda elevado. */
  function craterProfile(v) {
    const d = Math.abs(v);
    const basin = -smoothstep(0.34, 0.02, d);
    const rim = smoothstep(0.30, 0.40, d) * smoothstep(0.58, 0.42, d);
    return basin * 0.55 + rim * 0.5;
  }

  /**
   * Elevação em unidades de mundo, RELATIVA ao raio base do planeta.
   * Negativo = abaixo do nível do mar (fundo oceânico).
   *
   * @param {number} x componente da direção UNITÁRIA na esfera
   */
  function heightAt(x, y, z) {
    const w = warp(x, y, z);

    // 1. Continentes: baixa frequência, define o que é terra e o que é mar.
    let continent = fbm(nContinent, w[0], w[1], w[2], 5, P.continentFreq, 0.5, 2.0);
    continent -= P.oceanBias; // desloca o "nível do mar" => controla % de água

    // 2. Máscara continental: montanhas só crescem em terra firme.
    const landMask = smoothstep(-0.05, 0.30, continent);

    // -----------------------------------------------------------------------
    // 3. Cadeias montanhosas.
    //
    // O termo `ridged` sozinho dá relevo acidentado, mas com a mesma amplitude
    // em toda a região acidentada — morros do mesmo tamanho até o horizonte,
    // que é o que fazia o planeta parecer "ondulado" em vez de montanhoso.
    //
    // São três coisas empilhadas:
    //   - `belt`, um campo lento, decide ONDE há cordilheira. A frequência
    //     subiu de 0,6 para 1,5: a 0,6 metade do planeta inteiro era um bloco
    //     acidentado, e a cadeia deixava de ser uma feição para virar o padrão.
    //   - `crista` é o ruído ridged de sempre;
    //   - `pico` eleva a crista a uma potência, o que empurra os valores altos
    //     para cima e achata o resto. É o que separa cume de sopé: sem ele o
    //     mesmo `mountainness` que dá um pico decente enche o vale de calombos.
    // -----------------------------------------------------------------------
    const belt = smoothstep(-0.15, 0.5, nContinent(x * 1.5 + 100, y * 1.5, z * 1.5));
    const crista = Math.max(0, ridged(nMountain, x, y, z, 6, P.mountainFreq, 0.5, 2.1));
    const pico = Math.pow(crista, P.peakSharpness);
    const mountains = (crista * 0.35 + pico * 1.35) * landMask * belt * P.mountainness;

    // 4. Crateras: dominam mundos áridos, quase ausentes em mundos com oceano.
    const craters =
      craterProfile(nCrater(x * P.craterFreq, y * P.craterFreq, z * P.craterFreq)) *
      P.crateredness;

    // 5. Detalhe de média frequência (ondulações do relevo).
    const detail = fbm(nDetail, x, y, z, 4, P.detailFreq, 0.45, 2.3) * P.detailAmp;

    // 6. Rugosidade de escala métrica.
    //
    // Só faz sentido desde que existe exploração a pé. Visto da nave, este
    // termo é invisível; ao nível dos olhos, é a diferença entre pisar num
    // terreno e pisar numa casca de esfera perfeitamente lisa.
    //
    // A frequência precisa ser ALTA de verdade: `detailFreq` (~12) tem
    // comprimento de onda de mais de mil unidades na superfície — é relevo
    // regional, não chão. Para ondulações de ~10 unidades a frequência tem
    // que ser da ordem de centenas.
    const roughness = fbm(nDetail, x, y, z, 3, P.roughnessFreq, 0.5, 2.4) * P.roughnessAmp;

    // -----------------------------------------------------------------------
    // 7. Cânions.
    //
    // O ruído ridged, INVERTIDO: onde ele forma cume, aqui forma fenda. O
    // `smoothstep` estreito (0,88 a 1) é o que faz a parede ser parede — uma
    // faixa larga daria um vale suave, e o que dá vertigem é a queda começar de
    // uma vez, a um passo da borda.
    //
    // É a feição que mais muda a leitura da paisagem a pé: sem ela o relevo é
    // sempre convexo (morros e mais morros) e o mundo não tem nenhum lugar
    // onde se ENTRA. Não é caverna — um campo de altura não comporta teto — mas
    // é o buraco que se desce, se percorre e do qual se sai por outro lugar.
    // -----------------------------------------------------------------------
    const veio = 1 - Math.abs(nCrater(x * P.gorgeFreq + 7.7, y * P.gorgeFreq - 3.1, z * P.gorgeFreq));
    const canion = smoothstep(0.88, 1.0, veio) * landMask * P.gorgeDepth;

    const h = continent * 0.5 + mountains * 0.8 + craters * 0.12 + detail + roughness - canion;
    const elevacao = h * cfg.maxElevation;

    // As escavações entram DEPOIS da multiplicação por `maxElevation` porque
    // elas são medidas em unidades de mundo — um buraco de 4 unidades é 4
    // unidades numa lua e num gigante gasoso. Somá-las antes faria a mesma pá
    // de terra cavar fundos diferentes em cada planeta.
    return campo === null || campo.lista.length === 0
      ? elevacao
      : campo.alturaEm(x, y, z, elevacao);
  }

  /**
   * Umidade normalizada em [0,1] — separa deserto de floresta.
   *
   * ---------------------------------------------------------------------
   * DUAS ESCALAS, E A SEGUNDA É A QUE SE ANDA
   * ---------------------------------------------------------------------
   * Havia só o termo lento (frequência ~1,4 sobre a esfera unitária), cujo
   * comprimento de onda é da ordem do próprio planeta. O resultado era
   * honesto no mapa e monótono no chão: um hemisfério úmido e outro seco,
   * então uma caminhada de vários minutos acontecia inteira dentro do mesmo
   * bioma. O planeta tinha seis biomas e o jogador via um.
   *
   * O termo REGIONAL, algumas vezes mais rápido, quebra isso em manchas de
   * poucos quilômetros: bosque, campo aberto e areia dentro do mesmo passeio.
   * O peso menor mantém o clima planetário mandando na média — continua
   * existindo um lado úmido do mundo, com variação dentro dele.
   */
  function moistureAt(x, y, z) {
    // O clima planetário fica EXATAMENTE como era, e a mancha entra somada por
    // cima. Misturar os dois com pesos que somam 1 seria o caminho natural e
    // reduziria a variação: somar dois campos independentes concentra o
    // resultado no meio da faixa, e menos pontos cruzariam os limiares de
    // bioma — o planeta ficaria MAIS uniforme, que é o oposto do objetivo.
    const clima = fbm(nMoisture, x, y, z, 3, 1.4, 0.5, 2.0) * 0.5 + 0.5;
    const mancha = fbm(nMoisture, x + 41.7, y - 18.3, z + 9.1, 3, P.patchFreq, 0.5, 2.15);
    return clamp(clima + mancha * P.patchAmp, 0, 1);
  }

  /**
   * Temperatura em [0,1]: fria nos polos, quente no equador, com variação
   * local e queda por altitude (lapse rate) — é isso que faz a linha de neve
   * acompanhar as montanhas em vez de ser um anel perfeito.
   */
  function temperatureAt(x, y, z, elevation) {
    const latitude = Math.abs(y); // eixo Y = eixo polar do planeta
    let t = 1 - latitude * latitude;
    t += nTemp(x * 1.1, y * 1.1, z * 1.1) * 0.14;
    // Variação regional, na mesma escala das manchas de umidade: é o que
    // permite um vale mais quente ao lado de um planalto gelado sem depender
    // da latitude. Sem ela, as faixas de temperatura são anéis perfeitos em
    // volta do planeta e a neve vira uma listra no mapa.
    t += nTemp(x * P.patchFreq + 5.3, y * P.patchFreq, z * P.patchFreq - 2.7) * P.patchAmp * 0.55;
    t -= Math.max(0, elevation / cfg.maxElevation) * P.lapseRate;
    return clamp(t * cfg.baseTemperature, 0, 1);
  }

  /** Classifica o bioma (para o HUD e para escolher a paleta). */
  function biomeAt(x, y, z, elevation, slope) {
    if (cfg.hasWater && elevation < 0) return BIOME_NAMES.OCEAN;
    if (cfg.hasWater && elevation < cfg.maxElevation * 0.012) return BIOME_NAMES.BEACH;

    const temp = temperatureAt(x, y, z, elevation);
    const moist = moistureAt(x, y, z);

    if (slope > 0.55) return BIOME_NAMES.ROCK;
    if (temp < 0.22) return BIOME_NAMES.SNOW;
    if (temp < 0.38) return BIOME_NAMES.TUNDRA;
    if (moist < 0.34) return BIOME_NAMES.DESERT;
    if (moist > 0.62) return BIOME_NAMES.FOREST;
    return BIOME_NAMES.GRASS;
  }

  /**
   * Cor do vértice em espaço LINEAR (a paleta já vem convertida de sRGB).
   * Escreve em `out` (Float32Array de 3) para não alocar por vértice.
   *
   * @param {number} slope 0 = plano, 1 = parede vertical
   */
  function colorAt(x, y, z, elevation, slope, out) {
    const e = elevation / cfg.maxElevation; // -1..1 aprox

    // -----------------------------------------------------------------------
    // TERRA REMEXIDA NÃO É PAREDÃO DE ROCHA.
    //
    // O declive governa duas escolhas de cor mais abaixo: rocha exposta em
    // encosta íngreme e ausência de neve em parede vertical. As duas são certas
    // para relevo natural e erradas para uma escavação — o declive de um buraco
    // recém-cavado satura o medidor, e o interior inteiro saía pintado de leito
    // rochoso, num salto de quase branco para quase preto em dois metros.
    //
    // Aqui o declive é AMOLECIDO na proporção do quanto aquele ponto foi
    // mexido, e só para efeito de cor: a geometria, a colisão e o cálculo de
    // bioma continuam usando o declive real. Uma vala passa a ter a cor do
    // chão de onde saiu, que é o que a intuição espera de terra revolvida.
    // -----------------------------------------------------------------------
    const mexido = campo === null || campo.lista.length === 0 ? 0 : campo.intensidadeEm(x, y, z);
    if (mexido > 0) slope = lerp(slope, Math.min(slope, 0.3), mexido);
    const temp = temperatureAt(x, y, z, elevation);
    const moist = moistureAt(x, y, z);

    let r, g, b;

    if (cfg.hasWater && elevation < 0) {
      // Fundo do mar: escurece com a profundidade.
      const depth = clamp(-e * 6, 0, 1);
      r = lerp(pal.shallowOcean[0], pal.deepOcean[0], depth);
      g = lerp(pal.shallowOcean[1], pal.deepOcean[1], depth);
      b = lerp(pal.shallowOcean[2], pal.deepOcean[2], depth);
    } else {
      // -------------------------------------------------------------------
      // TRÊS PARADAS NO EIXO DA UMIDADE: seco -> gramado -> mata.
      //
      // Com duas, a umidade só escolhia entre areia e verde-claro, e o
      // resultado era um planeta de uma cor só com regiões mais ou menos
      // desbotadas — os biomas existiam na classificação e não na tela. A
      // terceira parada é o que faz uma mancha de floresta aparecer como
      // mancha, vista da nave, sem depender de as árvores estarem carregadas.
      // -------------------------------------------------------------------
      const wet = smoothstep(0.30, 0.58, moist);
      r = lerp(pal.dry[0], pal.grass[0], wet);
      g = lerp(pal.dry[1], pal.grass[1], wet);
      b = lerp(pal.dry[2], pal.grass[2], wet);

      const mata = smoothstep(0.60, 0.80, moist);
      r = lerp(r, pal.forest[0], mata);
      g = lerp(g, pal.forest[1], mata);
      b = lerp(b, pal.forest[2], mata);

      const cold = smoothstep(0.42, 0.20, temp);
      r = lerp(r, pal.tundra[0], cold);
      g = lerp(g, pal.tundra[1], cold);
      b = lerp(b, pal.tundra[2], cold);

      // Faixa de praia logo acima da linha d'água.
      if (cfg.hasWater) {
        const beach = smoothstep(cfg.maxElevation * 0.018, 0, elevation) *
          smoothstep(-0.002 * cfg.maxElevation, 0, elevation);
        r = lerp(r, pal.sand[0], beach);
        g = lerp(g, pal.sand[1], beach);
        b = lerp(b, pal.sand[2], beach);
      }
    }

    // Rocha exposta em encostas íngremes — mesmo debaixo d'água.
    const rocky = smoothstep(0.42, 0.72, slope);
    r = lerp(r, pal.rock[0], rocky);
    g = lerp(g, pal.rock[1], rocky);
    b = lerp(b, pal.rock[2], rocky);

    // Neve: só em altitude fria E em terreno não-vertical (neve não gruda
    // em paredão — sem essa condição as montanhas viram picolés brancos).
    const snowT = smoothstep(0.30, 0.14, temp) * smoothstep(0.75, 0.45, slope);
    if (snowT > 0 && elevation > 0) {
      r = lerp(r, pal.snow[0], snowT);
      g = lerp(g, pal.snow[1], snowT);
      b = lerp(b, pal.snow[2], snowT);
    }

    // Variação fina para quebrar a uniformidade das superfícies grandes.
    const grain = 1 + nDetail(x * 220, y * 220, z * 220) * 0.05;
    out[0] = clamp(r * grain, 0, 1);
    out[1] = clamp(g * grain, 0, 1);
    out[2] = clamp(b * grain, 0, 1);
    return out;
  }

  /** Troca a camada de escavações (o worker usa por chunk; ver acima). */
  function usarCampo(novo) {
    campo = novo;
  }

  return { heightAt, colorAt, biomeAt, moistureAt, temperatureAt, usarCampo };
}
