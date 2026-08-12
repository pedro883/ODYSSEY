/**
 * Simplex Noise 3D determinístico e seedável.
 *
 * Implementação própria (baseada no algoritmo de Ken Perlin / Stefan Gustavson)
 * em vez do pacote `simplex-noise` por dois motivos práticos:
 *   1. Zero dependências fora do Three.js — o mesmo arquivo é importado pela
 *      main thread e pelo Web Worker sem risco de divergência de versão.
 *   2. Controle total do seed: o worker precisa reconstruir EXATAMENTE o mesmo
 *      campo de ruído que a main thread usa para calcular altitude da nave.
 *
 * Se preferir a lib: `npm i simplex-noise` e troque `createNoise3D` por
 * `import { createNoise3D } from 'simplex-noise'` — a assinatura é compatível
 * (recebe uma função PRNG, devolve `(x, y, z) => number` em [-1, 1]).
 */

/** PRNG rápido e determinístico (32 bits). */
export function mulberry32(a) {
  let s = a >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Converte uma string em um inteiro de 32 bits (hash FNV-1a simplificado). */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Gradientes do simplex 3D: as 12 arestas de um cubo.
const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

const F3 = 1 / 3;
const G3 = 1 / 6;

/**
 * Cria uma função de ruído simplex 3D.
 * @param {number|string} seed
 * @returns {(x:number, y:number, z:number) => number} valor aproximadamente em [-1, 1]
 */
export function createNoise3D(seed) {
  const random = mulberry32(typeof seed === 'string' ? hashString(seed) : seed | 0);

  // Tabela de permutação embaralhada pelo seed (Fisher-Yates).
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (random() * (i + 1)) | 0;
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }

  // Duplicada para evitar `& 255` extra dentro do loop quente.
  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    permMod12[i] = perm[i] % 12;
  }

  return function noise3D(xin, yin, zin) {
    // 1. Distorce o espaço de entrada para a grade simplex.
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);

    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);

    // 2. Descobre em qual dos 6 tetraedros do cubo unitário estamos.
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
      } else if (x0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1;
      } else {
        i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1;
      }
    } else {
      if (y0 < z0) {
        i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1;
      } else if (x0 < z0) {
        i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1;
      } else {
        i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
      }
    }

    // 3. Deslocamentos para os outros 3 cantos do tetraedro.
    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;

    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;

    // 4. Contribuição de cada canto, ponderada por um kernel radial.
    let n = 0;

    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const gi = permMod12[ii + perm[jj + perm[kk]]] * 3;
      t0 *= t0;
      n += t0 * t0 * (GRAD3[gi] * x0 + GRAD3[gi + 1] * y0 + GRAD3[gi + 2] * z0);
    }

    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const gi = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
      t1 *= t1;
      n += t1 * t1 * (GRAD3[gi] * x1 + GRAD3[gi + 1] * y1 + GRAD3[gi + 2] * z1);
    }

    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const gi = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
      t2 *= t2;
      n += t2 * t2 * (GRAD3[gi] * x2 + GRAD3[gi + 1] * y2 + GRAD3[gi + 2] * z2);
    }

    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const gi = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
      t3 *= t3;
      n += t3 * t3 * (GRAD3[gi] * x3 + GRAD3[gi + 1] * y3 + GRAD3[gi + 2] * z3);
    }

    return 32 * n;
  };
}

/* -------------------------------------------------------------------------
   Utilitários usados pelo gerador de terreno
   ------------------------------------------------------------------------- */

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** smoothstep do GLSL. Aceita e0 > e1 para inverter a rampa. */
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * fBm (fractional Brownian motion): soma de oitavas de ruído.
 * Produz relevo "orgânico" — colinas suaves em baixa frequência com detalhe fino.
 */
export function fbm(noise, x, y, z, octaves, freq, gain = 0.5, lacunarity = 2.0) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq, y * freq, z * freq);
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return sum / norm;
}

/**
 * Ridged multifractal: `1 - |noise|` elevado ao quadrado.
 * É o que produz as cristas afiadas de cadeias montanhosas — o fBm puro
 * gera colinas arredondadas demais para virar montanha.
 */
export function ridged(noise, x, y, z, octaves, freq, gain = 0.5, lacunarity = 2.0) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let weight = 1;
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(noise(x * freq, y * freq, z * freq));
    n *= n;
    n *= weight;
    // Oitavas seguintes só aparecem onde a anterior já era alta => cristas finas.
    weight = clamp(n * 2, 0, 1);
    sum += amp * n;
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return (sum / norm) * 2 - 1;
}
