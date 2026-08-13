/**
 * Gera todos os parâmetros de um planeta a partir de um único inteiro (o seed).
 *
 * Este é o coração da geração procedural "no estilo No Man's Sky": nada do
 * planeta é armazenado — nem malha, nem textura, nem cor. Dado o mesmo seed,
 * qualquer máquina reconstrói exatamente o mesmo mundo. Para ter um universo
 * infinito basta variar o seed (ex.: hash das coordenadas do setor galáctico).
 */

import * as THREE from 'three';
import { mulberry32 } from '../shared/noise.js';
import { RESOURCES } from '../shared/props.js';

/**
 * Converte um hex sRGB nas componentes LINEARES que o Three.js usa internamente.
 *
 * Detalhe que costuma passar batido: com `ColorManagement` ligado (padrão desde
 * o r152), `new THREE.Color(hex)` JÁ devolve `.r/.g/.b` em linear-sRGB. Chamar
 * `convertSRGBToLinear()` aqui aplicaria a curva duas vezes e deixaria o planeta
 * visivelmente escuro demais.
 */
function toLinear(hex) {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

function hslToLinear(h, s, l) {
  const c = new THREE.Color();
  c.setHSL(h, s, l, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
}

/**
 * Coeficientes de espalhamento Rayleigh para um céu de um dado matiz.
 *
 * O erro tentador aqui é usar direto a cor do céu (ex.: um ciano puro). O
 * resultado é um planeta com halo de neon e SEM pôr do sol: com o canal
 * vermelho zerado, não sobra nada para avermelhar quando a luz atravessa
 * bastante ar. Espalhamento é seletivo por comprimento de onda, não uma cor.
 *
 * Partimos da razão física real (~1/λ⁴, que na Terra dá 5.8:13.5:33.1 e por
 * isso o céu é azul) e interpolamos em direção ao matiz do planeta, mantendo
 * os três canais vivos.
 *
 * @param {number} hue matiz do céu em [0,1]
 * @param {number} dominance quanto o matiz sobrepõe a curva física
 */
function scatteringCoefficients(hue, dominance = 0.62) {
  const RAYLEIGH_EARTH = [0.175, 0.41, 1.0];

  const tint = hslToLinear(hue, 0.62, 0.5);
  const peak = Math.max(tint[0], tint[1], tint[2]) || 1;

  return RAYLEIGH_EARTH.map((physical, i) =>
    physical + (tint[i] / peak - physical) * dominance
  );
}

const NAME_PREFIX = ['Ax', 'Bel', 'Cor', 'Dra', 'Ely', 'Fen', 'Gal', 'Hyp', 'Ios', 'Kar', 'Lyr', 'Mor', 'Neb', 'Ori', 'Pyr', 'Qel', 'Rho', 'Sil', 'Tal', 'Vex', 'Zar'];
const NAME_MIDDLE = ['a', 'e', 'i', 'o', 'u', 'ae', 'ia', 'or', 'un', 'yr'];
const NAME_SUFFIX = ['dis', 'thys', 'ron', 'mir', 'vex', 'nor', 'tara', 'lex', 'pheus', 'gard', 'vion', 'cyra'];

function planetName(rand) {
  const pick = (arr) => arr[(rand() * arr.length) | 0];
  const roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'IX', 'XII'];
  return `${pick(NAME_PREFIX)}${pick(NAME_MIDDLE)}${pick(NAME_SUFFIX)} ${pick(roman)}`;
}

/**
 * @param {number} seed
 * @param {number} scale multiplicador de tamanho do corpo (luas são menores)
 *
 *   Entra AQUI, e não depois, porque tudo o que importa deriva do raio:
 *   elevação máxima, espessura da atmosfera, altura e tamanho das nuvens. Um
 *   `config.radius *= escala` aplicado depois da construção do planeta deixa
 *   essas grandezas dessincronizadas — e, pior, o worker já recebeu uma CÓPIA
 *   da config e nunca fica sabendo (ver o comentário em `StarSystem.js`).
 *
 * @returns {object} config serializável (atravessa structured-clone até o worker)
 */
export function createPlanetConfig(seed, scale = 1) {
  const rand = mulberry32(seed);
  const between = (a, b) => a + rand() * (b - a);

  // --- Classe do planeta -------------------------------------------------
  // A classe enviesa TODO o resto: um mundo árido ganha crateras e perde
  // oceano; um mundo glacial ganha neve em quase toda latitude.
  const roll = rand();
  const type =
    roll < 0.38 ? 'temperado' :
    roll < 0.60 ? 'árido' :
    roll < 0.76 ? 'glacial' :
    roll < 0.90 ? 'exótico' : 'vulcânico';

  const hasWater = type === 'temperado' || type === 'exótico' || (type === 'glacial' && rand() > 0.4);

  // O sorteio acontece na escala 1 e só depois é multiplicado: assim a escala
  // não consome números do gerador e o mesmo seed produz o MESMO mundo, grande
  // ou pequeno. Trocar a ordem faria uma lua ser um planeta diferente.
  const radius = between(2200, 3200) * scale;
  const maxElevation = radius * between(0.022, 0.042);

  // --- Paleta ------------------------------------------------------------
  // Um matiz base por planeta mantém a superfície coerente; os desvios abaixo
  // são pequenos de propósito (paletas totalmente aleatórias ficam "sujas").
  const baseHue = rand();
  const vegHue =
    type === 'exótico' ? baseHue :
    type === 'vulcânico' ? between(0.02, 0.09) :
    between(0.20, 0.42); // verdes/oliva plausíveis

  const soilHue = type === 'vulcânico' ? between(0.0, 0.05) : between(0.05, 0.13);

  const palette = {
    deepOcean: hslToLinear((baseHue + 0.55) % 1, 0.75, 0.09),
    shallowOcean: hslToLinear((baseHue + 0.52) % 1, 0.62, 0.26),
    sand: hslToLinear(soilHue + 0.02, 0.42, 0.60),
    grass: hslToLinear(vegHue, type === 'exótico' ? 0.72 : 0.45, 0.34),
    dry: hslToLinear(soilHue, 0.40, 0.44),
    tundra: hslToLinear((vegHue + 0.08) % 1, 0.18, 0.42),
    rock: hslToLinear(soilHue, 0.12, type === 'vulcânico' ? 0.16 : 0.30),
    snow: toLinear(0xf2f7ff),
  };

  // --- Folhagem ------------------------------------------------------------
  // Separada de `palette.grass` de propósito. Usar a cor do gramado em toda a
  // vegetação era o motivo de TODA árvore sair do mesmo verde chapado: um só
  // valor, aplicado a copa, arbusto e folha, em todos os planetas.
  //
  // Aqui a folhagem ganha um matiz PRÓPRIO, um desvio por espécie e uma faixa
  // de variação por indivíduo. É o mesmo princípio da paleta do terreno — a
  // coerência vem do matiz base, a vida vem do desvio — só que aplicado à
  // camada que o jogador vê de perto, que é onde a falta dela salta aos olhos.
  const foliageHue =
    type === 'exótico' ? (baseHue + 0.42) % 1 :
    type === 'vulcânico' ? between(0.02, 0.08) :
    type === 'glacial' ? between(0.28, 0.42) :
    between(0.16, 0.36);

  // Quanto o matiz pode andar entre uma árvore e outra. Um pouco de outono num
  // mundo temperado; num mundo exótico, quase nada — lá a estranheza vem da
  // saturação, e espalhar o matiz só suja a paleta.
  const foliageSpread = type === 'exótico' ? 0.05 : between(0.06, 0.14);

  const foliage = {
    hue: foliageHue,
    spread: foliageSpread,
    saturation: type === 'exótico' ? 0.78 : type === 'glacial' ? 0.34 : between(0.42, 0.62),
    lightness: type === 'vulcânico' ? 0.24 : between(0.30, 0.44),
    // Casca: marrom real, nunca a cor da paleta. Tronco verde é o que mais
    // denuncia vegetação tingida por cima.
    bark: hslToLinear(between(0.05, 0.10), between(0.18, 0.38), between(0.20, 0.34)),
  };

  // --- Atmosfera ---------------------------------------------------------
  // `rayleigh` controla a cor do céu (azul na Terra porque o azul espalha
  // ~5.5x mais que o vermelho); `mie` é o halo esbranquiçado ao redor do sol.
  const skyHue =
    type === 'exótico' ? (baseHue + 0.3) % 1 :
    type === 'árido' ? between(0.03, 0.10) :
    between(0.52, 0.62);

  const atmosphere = {
    height: radius * between(0.075, 0.11),
    rayleigh: scatteringCoefficients(skyHue),
    mie: toLinear(0xffe9c4),
    // Cor PERCEBIDA do céu diurno. Separada dos coeficientes acima de
    // propósito: aqueles são "quanto cada comprimento de onda espalha" e
    // podem passar de 1; esta é uma cor de verdade, usada pela névoa e pela
    // luz ambiente para casar com o que a atmosfera desenha.
    tint: hslToLinear(skyHue, 0.45, 0.62),
    density: between(0.9, 1.6),
    // Escala de altura: quão rápido o ar rareia com a altitude.
    scaleHeight: 0.22,
  };

  const sunColor = toLinear(type === 'vulcânico' ? 0xffd0a0 : 0xfff4e2);

  // --- Nuvens --------------------------------------------------------------
  // A base fica ACIMA do pico mais alto possível (`maxElevation` é o teto do
  // relevo), senão a camada atravessaria montanhas — e ver uma cordilheira
  // furar uma nuvem por dentro entrega o truque na hora.
  const cloudBottom = maxElevation * 1.25 + radius * 0.008;
  const cloudCoverage =
    type === 'árido' ? between(0.12, 0.28) :
    type === 'vulcânico' ? between(0.30, 0.48) :
    type === 'glacial' ? between(0.45, 0.68) :
    type === 'exótico' ? between(0.30, 0.60) :
    between(0.35, 0.62);

  const clouds = {
    bottom: cloudBottom,
    top: cloudBottom + atmosphere.height * between(0.28, 0.45),
    coverage: cloudCoverage,
    density: between(1.6, 2.6),
    // Tamanho das massas em unidades de mundo. Proporcional ao raio para que a
    // lua tenha nuvens de lua e não os mesmos cúmulos de um gigante.
    featureScale: radius * between(0.055, 0.10),
    // Vento em "features por segundo": lento de propósito. Nuvem que corre é
    // a coisa que mais denuncia escala errada — a 200 unidades de altura, um
    // cúmulo real leva minutos para cruzar o campo de visão.
    wind: [between(-0.012, 0.012), 0, between(-0.012, 0.012)],
    // Nuvem vulcânica é cinza de fuligem; as outras, brancas com um toque do
    // matiz do céu, que é o que as integra à atmosfera em vez de deixá-las
    // coladas por cima como adesivo.
    color:
      type === 'vulcânico'
        ? hslToLinear(between(0.03, 0.08), 0.15, 0.30)
        : hslToLinear(skyHue, 0.10, 0.86),
  };

  return {
    seed,
    name: planetName(rand),
    type,
    radius,
    maxElevation,
    hasWater,
    baseTemperature:
      type === 'glacial' ? 0.55 :
      type === 'vulcânico' ? 1.35 :
      type === 'árido' ? 1.15 : 1.0,

    palette,
    foliage,
    atmosphere,
    clouds,
    sunColor,
    waterColor: hslToLinear((baseHue + 0.53) % 1, 0.7, 0.22),

    // Um recurso "assinatura" por planeta, em vez de todos misturados. É o que
    // dá motivo para voltar a um mundo específico — e o que faz o jogador
    // aprender o sistema em vez de coletar aleatoriamente.
    depositResource: (seed >>> 3) % RESOURCES.length,

    // --- Parâmetros do campo de ruído ------------------------------------
    terrain: {
      continentFreq: between(0.7, 1.15),
      mountainFreq: between(2.0, 3.4),
      detailFreq: between(9, 16),
      detailAmp: between(0.04, 0.08),
      // Rugosidade métrica: só perceptível a pé, mas essencial lá.
      roughnessFreq: between(220, 380),
      roughnessAmp: between(0.004, 0.009),
      warpFreq: between(1.2, 2.2),
      warpStrength: between(0.12, 0.30),
      craterFreq: between(2.5, 5.0),
      crateredness: hasWater ? between(0, 0.25) : between(0.4, 1.0),
      mountainness: between(0.6, 1.3),
      oceanBias: hasWater ? between(0.02, 0.22) : -0.35,
      lapseRate: between(0.3, 0.6),
    },

    // --- LOD ---------------------------------------------------------------
    lod: {
      // Vértices por lado de um chunk (32 => 33x33 = 1089 vértices + saias).
      // Potência de 2 mantém o index buffer compartilhável entre níveis.
      chunkRes: 32,
      // Profundidade máxima da quadtree. Tamanho do menor chunk =
      // 2*radius / 2^maxLevel  ≈ 11 unidades para radius=2800, level=9.
      maxLevel: 9,
      // Quanto MAIOR, mais cedo o chunk subdivide (mais detalhe, mais draw calls).
      splitFactor: 1.7,
      // Profundidade da "saia" que esconde as fissuras entre níveis de LOD,
      // em fração do tamanho do chunk.
      skirtRatio: 0.06,
    },
  };
}
