/**
 * Worker de geração de terreno — agora multi-planeta.
 *
 * Um único pool de workers atende TODOS os planetas do sistema. Cada worker
 * mantém um mapa `planetId -> sampler`: registrar um planeta custa a
 * construção das tabelas de ruído (~1 ms) e acontece uma vez. Um pool por
 * planeta seria muito pior — 4 planetas × 6 workers = 24 threads brigando
 * por 8 núcleos.
 *
 * Protocolo:
 *   main -> worker : { type:'register', planetId, config }
 *   worker -> main : { type:'registered', planetId }
 *   main -> worker : { type:'build', id, planetId, face, u0, v0, size, withProps }
 *   worker -> main : { type:'chunk', id, positions, normals, colors, props, ... }
 */

import { createTerrainSampler, faceDirection } from '../shared/terrain.js';
import { mulberry32 } from '../shared/noise.js';
import { PROP_TYPE, biomeScatter } from '../shared/props.js';

/** @type {Map<number, {cfg: object, sampler: object}>} */
const planets = new Map();

self.onmessage = (event) => {
  const msg = event.data;

  if (msg.type === 'register') {
    planets.set(msg.planetId, {
      cfg: msg.config,
      sampler: createTerrainSampler(msg.config),
    });
    self.postMessage({ type: 'registered', planetId: msg.planetId });
    return;
  }

  if (msg.type === 'build') {
    const planet = planets.get(msg.planetId);
    if (!planet) return;
    const result = buildChunk(msg, planet.cfg, planet.sampler);
    self.postMessage(result, [
      result.positions.buffer,
      result.normals.buffer,
      result.colors.buffer,
      result.props.buffer,
    ]);
  }
};

/** Acumula a normal da face (a,b,c) nos três vértices. */
function accumulateFaceNormal(pos, nrm, a, b, c) {
  const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
  const e1x = pos[b] - ax, e1y = pos[b + 1] - ay, e1z = pos[b + 2] - az;
  const e2x = pos[c] - ax, e2y = pos[c + 1] - ay, e2z = pos[c + 2] - az;

  // Não normalizamos a face: o módulo do produto vetorial é 2x a área do
  // triângulo, então triângulos maiores pesam mais — que é exatamente o
  // comportamento desejado numa malha com quads de tamanhos diferentes.
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;

  nrm[a] += nx; nrm[a + 1] += ny; nrm[a + 2] += nz;
  nrm[b] += nx; nrm[b + 1] += ny; nrm[b + 2] += nz;
  nrm[c] += nx; nrm[c + 1] += ny; nrm[c + 2] += nz;
}

/**
 * Hash determinístico do chunk. Precisa depender só de dados que identificam
 * o chunk (nunca de ordem de chegada ou tempo), senão a vegetação "dança" ao
 * recarregar o mesmo pedaço de terreno.
 */
function chunkSeed(planetId, face, u0, v0) {
  let h = (planetId * 374761393 + face * 668265263) >>> 0;
  h = (h ^ Math.round(u0 * 1048576) * 2246822519) >>> 0;
  h = (h ^ Math.round(v0 * 1048576) * 3266489917) >>> 0;
  return h >>> 0;
}

function buildChunk(req, cfg, sampler) {
  const { id, face, u0, v0, size, withProps } = req;

  const res = cfg.lod.chunkRes;
  const N = res + 1;        // vértices por lado do chunk
  const PAD = res + 3;      // grade com 1 anel extra de cada lado
  const step = size / res;
  const radius = cfg.radius;

  // -----------------------------------------------------------------------
  // 1. Amostra a grade COM PADDING.
  //
  // O anel extra é o que garante normais contínuas na costura entre chunks
  // vizinhos: sem ele, os vértices da borda só conheceriam os triângulos de
  // dentro do próprio chunk e a iluminação mostraria uma grade de "vincos".
  // -----------------------------------------------------------------------
  const padPos = new Float32Array(PAD * PAD * 3);
  const padNrm = new Float32Array(PAD * PAD * 3);
  const padDir = new Float32Array(PAD * PAD * 3);
  const padElev = new Float32Array(PAD * PAD);

  const dir = [0, 0, 0];
  let minElev = Infinity;
  let maxElev = -Infinity;

  for (let py = 0; py < PAD; py++) {
    const v = v0 + (py - 1) * step;
    for (let px = 0; px < PAD; px++) {
      const u = u0 + (px - 1) * step;

      faceDirection(face, u, v, dir);
      const elev = sampler.heightAt(dir[0], dir[1], dir[2]);
      const r = radius + elev;

      const i = py * PAD + px;
      const i3 = i * 3;

      padDir[i3] = dir[0]; padDir[i3 + 1] = dir[1]; padDir[i3 + 2] = dir[2];
      padPos[i3] = dir[0] * r; padPos[i3 + 1] = dir[1] * r; padPos[i3 + 2] = dir[2] * r;
      padElev[i] = elev;

      // Só o interior conta para a faixa de elevação (o padding extrapola).
      if (px > 0 && px < PAD - 1 && py > 0 && py < PAD - 1) {
        if (elev < minElev) minElev = elev;
        if (elev > maxElev) maxElev = elev;
      }
    }
  }

  // 2. Normais por acumulação de faces sobre a grade com padding.
  for (let py = 0; py < PAD - 1; py++) {
    for (let px = 0; px < PAD - 1; px++) {
      const a = (py * PAD + px) * 3;
      const b = (py * PAD + px + 1) * 3;
      const c = ((py + 1) * PAD + px) * 3;
      const d = ((py + 1) * PAD + px + 1) * 3;
      // Mesmo winding do index buffer: (a,b,d) e (a,d,c).
      accumulateFaceNormal(padPos, padNrm, a, b, d);
      accumulateFaceNormal(padPos, padNrm, a, d, c);
    }
  }

  // -----------------------------------------------------------------------
  // 3. Extrai o interior, com posições RELATIVAS ao centro do chunk.
  //
  // Isso é obrigatório em escala planetária: um vértice a 2800 unidades da
  // origem só tem ~4 casas decimais úteis em float32. Guardando o offset em
  // relação ao centro do chunk (e pondo o centro em `mesh.position`), a
  // precisão volta a ser a do tamanho do chunk, não a do planeta.
  // -----------------------------------------------------------------------
  const vertexCount = N * N + N * 4; // interior + 4 fileiras de saia
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);

  const ci = ((res >> 1) + 1) * PAD + ((res >> 1) + 1);
  const cx = padPos[ci * 3];
  const cy = padPos[ci * 3 + 1];
  const cz = padPos[ci * 3 + 2];

  const rgb = [0, 0, 0];
  let boundingRadiusSq = 0;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const src = ((y + 1) * PAD + (x + 1)) * 3;
      const dst = (y * N + x) * 3;

      const px = padPos[src] - cx;
      const py = padPos[src + 1] - cy;
      const pz = padPos[src + 2] - cz;
      positions[dst] = px;
      positions[dst + 1] = py;
      positions[dst + 2] = pz;

      const d2 = px * px + py * py + pz * pz;
      if (d2 > boundingRadiusSq) boundingRadiusSq = d2;

      let nx = padNrm[src], ny = padNrm[src + 1], nz = padNrm[src + 2];
      const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
      nx *= inv; ny *= inv; nz *= inv;
      normals[dst] = nx; normals[dst + 1] = ny; normals[dst + 2] = nz;

      const dx = padDir[src], dy = padDir[src + 1], dz = padDir[src + 2];
      // Declive: 0 = plano (normal aponta para fora), 1 = parede vertical.
      const slope = 1 - Math.max(0, nx * dx + ny * dy + nz * dz);

      sampler.colorAt(dx, dy, dz, padElev[(y + 1) * PAD + (x + 1)], slope, rgb);
      colors[dst] = rgb[0]; colors[dst + 1] = rgb[1]; colors[dst + 2] = rgb[2];
    }
  }

  // -----------------------------------------------------------------------
  // 4. Saias (skirts).
  //
  // Entre um chunk nível N e um vizinho nível N+1 a borda não coincide, e
  // aparece uma fissura por onde se vê o espaço. Em vez de costurar índices
  // (complexo, 4 variantes por chunk), estendemos uma "parede" para dentro do
  // planeta na borda. Ela fica escondida atrás da geometria do vizinho.
  //
  // A profundidade acompanha o relevo LOCAL do chunk: um platô plano quase
  // não precisa de saia, um pico de montanha precisa de bastante.
  // -----------------------------------------------------------------------
  const chunkWorldSize = 2 * radius * size;
  const skirtDepth = chunkWorldSize * cfg.lod.skirtRatio + (maxElev - minElev) * 0.35;

  const base = N * N;
  const edges = [
    { start: base + N * 0, get: (i) => i },                 // borda v=0   (topo)
    { start: base + N * 1, get: (i) => (N - 1) * N + i },   // borda v=1   (base)
    { start: base + N * 2, get: (i) => i * N },             // borda u=0   (esquerda)
    { start: base + N * 3, get: (i) => i * N + (N - 1) },   // borda u=1   (direita)
  ];

  for (const edge of edges) {
    for (let i = 0; i < N; i++) {
      const srcIdx = edge.get(i) * 3;
      const dstIdx = (edge.start + i) * 3;

      const ax = positions[srcIdx] + cx;
      const ay = positions[srcIdx + 1] + cy;
      const az = positions[srcIdx + 2] + cz;
      const inv = 1 / Math.hypot(ax, ay, az);

      positions[dstIdx] = positions[srcIdx] - ax * inv * skirtDepth;
      positions[dstIdx + 1] = positions[srcIdx + 1] - ay * inv * skirtDepth;
      positions[dstIdx + 2] = positions[srcIdx + 2] - az * inv * skirtDepth;

      normals[dstIdx] = normals[srcIdx];
      normals[dstIdx + 1] = normals[srcIdx + 1];
      normals[dstIdx + 2] = normals[srcIdx + 2];
      colors[dstIdx] = colors[srcIdx];
      colors[dstIdx + 1] = colors[srcIdx + 1];
      colors[dstIdx + 2] = colors[srcIdx + 2];
    }
  }

  // 5. Vegetação, rochas e depósitos (só nos níveis de LOD mais finos).
  const props = withProps
    ? scatterProps(req, cfg, sampler, { padPos, padNrm, padDir, padElev, PAD, N, step, cx, cy, cz })
    : new Float32Array(0);

  return {
    type: 'chunk',
    id,
    // Ecoado para que a main thread saiba a qual planeta entregar o resultado
    // (o pool é compartilhado entre todos).
    planetId: req.planetId,
    positions,
    normals,
    colors,
    props,
    center: [cx, cy, cz],
    // A esfera envolvente precisa cobrir também a saia, senão o frustum
    // culling do Three.js some com o chunk em ângulos rasantes.
    boundingRadius: Math.sqrt(boundingRadiusSq) + skirtDepth,
    minElev,
    maxElev,
  };
}

/* ==========================================================================
   Espalhamento de props
   ========================================================================== */

/** Campos por instância no buffer devolvido. */
export const PROP_STRIDE = 8;

/**
 * Distribui vegetação/rochas/depósitos sobre o chunk.
 *
 * Reaproveita a grade JÁ amostrada em vez de reavaliar o campo de ruído: cada
 * candidato custa uma leitura de array em vez de ~20 oitavas de fBm. Sem isso
 * o custo de um chunk com props dobraria.
 *
 * A distribuição é jitter em grade (não aleatório puro): pontos puramente
 * aleatórios formam aglomerados e buracos visíveis, o jitter dá cobertura
 * uniforme mantendo aparência natural.
 */
function scatterProps(req, cfg, sampler, grid) {
  const { face, u0, v0, size, planetId } = req;
  const { padPos, padNrm, padDir, padElev, PAD, N, cx, cy, cz } = grid;

  const rand = mulberry32(chunkSeed(planetId, face, u0, v0));
  const chunkWorldSize = 2 * cfg.radius * size;

  // -----------------------------------------------------------------------
  // Densidade constante por ÁREA.
  //
  // Usar um número FIXO de candidatos por chunk é o erro tentador: a área de
  // um chunk cai 4x a cada nível de LOD, então a mesma contagem produz 4x mais
  // props por metro quadrado no nível seguinte — o planeta vira um tapete de
  // pedras exatamente onde o jogador chega mais perto.
  //
  // Derivando o número de células do TAMANHO DO CHUNK, o espaçamento em
  // unidades de mundo fica constante e a densidade não depende do LOD.
  // -----------------------------------------------------------------------
  const SPACING = 4.0;
  const cells = Math.max(2, Math.min(16, Math.round(chunkWorldSize / SPACING)));
  const out = [];

  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      // Célula da grade do chunk correspondente a este candidato.
      const fx = (i + rand()) / cells;
      const fy = (j + rand()) / cells;
      const gx = Math.min(N - 1, Math.floor(fx * (N - 1)));
      const gy = Math.min(N - 1, Math.floor(fy * (N - 1)));
      const src = ((gy + 1) * PAD + (gx + 1)) * 3;
      const elev = padElev[(gy + 1) * PAD + (gx + 1)];

      // Nada nasce debaixo d'água.
      if (cfg.hasWater && elev < 0) continue;

      const nx = padNrm[src], ny = padNrm[src + 1], nz = padNrm[src + 2];
      const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
      const dx = padDir[src], dy = padDir[src + 1], dz = padDir[src + 2];
      const slope = 1 - Math.max(0, (nx * inv) * dx + (ny * inv) * dy + (nz * inv) * dz);

      const biome = sampler.biomeAt(dx, dy, dz, elev, slope);
      const scatter = biomeScatter(biome, cfg.type);

      // Encostas íngremes só seguram rocha.
      const steep = slope > 0.45;

      const roll = rand();
      let type = -1;
      let acc = 0;
      for (let t = 0; t < scatter.weights.length; t++) {
        acc += scatter.weights[t];
        if (roll < acc) { type = t; break; }
      }
      if (type < 0) continue;
      if (steep && type !== PROP_TYPE.ROCK) continue;

      // Depósitos são raros de propósito: são o objetivo da exploração.
      if (type === PROP_TYPE.DEPOSIT && rand() > 0.16) continue;

      out.push(
        padPos[src] - cx,
        padPos[src + 1] - cy,
        padPos[src + 2] - cz,
        // Escala ABSOLUTA: um arbusto tem o mesmo tamanho independente do
        // nível de LOD do chunk em que caiu. Escalar pelo tamanho do chunk
        // faria a mesma planta encolher ao se aproximar dela.
        scatter.scale[type] * (0.7 + rand() * 0.6),
        rand() * Math.PI * 2,
        type,
        rand(),
        // Índice do recurso: fixo por planeta para depósitos, para que o
        // jogador aprenda "este mundo tem X".
        (cfg.seed + type) % 4
      );
    }
  }

  return new Float32Array(out);
}
