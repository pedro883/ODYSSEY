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
export function createTerrainSampler(cfg) {
  const seed = cfg.seed;

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

    // 3. Cadeias montanhosas (ridged), moduladas por um segundo campo lento
    //    para que existam regiões planas e regiões acidentadas.
    const belt = smoothstep(-0.2, 0.45, nContinent(x * 0.6 + 100, y * 0.6, z * 0.6));
    const mountains =
      Math.max(0, ridged(nMountain, x, y, z, 6, P.mountainFreq, 0.5, 2.1)) *
      landMask *
      belt *
      P.mountainness;

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

    const h = continent * 0.5 + mountains * 0.8 + craters * 0.12 + detail + roughness;
    return h * cfg.maxElevation;
  }

  /** Umidade normalizada em [0,1] — separa deserto de floresta. */
  function moistureAt(x, y, z) {
    return clamp(fbm(nMoisture, x, y, z, 3, 1.4, 0.5, 2.0) * 0.5 + 0.5, 0, 1);
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
      // Terra: interpola úmido <-> seco, depois esfria em direção aos polos.
      const wet = smoothstep(0.32, 0.66, moist);
      r = lerp(pal.dry[0], pal.grass[0], wet);
      g = lerp(pal.dry[1], pal.grass[1], wet);
      b = lerp(pal.dry[2], pal.grass[2], wet);

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

  return { heightAt, colorAt, biomeAt, moistureAt, temperatureAt };
}
