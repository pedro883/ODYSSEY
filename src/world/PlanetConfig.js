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
 * @returns {object} config serializável (atravessa structured-clone até o worker)
 */
export function createPlanetConfig(seed) {
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

  const radius = between(2200, 3200);
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
    atmosphere,
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
