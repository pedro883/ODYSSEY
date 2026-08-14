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
import { CampoDeEdicoes } from '../shared/edits.js';

/** @type {Map<number, {cfg: object, sampler: object, campo: CampoDeEdicoes}>} */
const planets = new Map();

self.onmessage = (event) => {
  const msg = event.data;

  if (msg.type === 'register') {
    const campo = new CampoDeEdicoes(msg.config.radius);
    if (msg.edicoes?.length) campo.definir(msg.edicoes);
    planets.set(msg.planetId, {
      cfg: msg.config,
      campo,
      sampler: createTerrainSampler(msg.config, campo),
    });
    self.postMessage({ type: 'registered', planetId: msg.planetId });
    return;
  }

  // Escavações. Chegam avulsas (o jogador cavou) ou em bloco (restauração do
  // banco ao entrar na sala). Não respondem nada: quem pediu a mudança já
  // invalidou os chunks da região e vai repedi-los.
  if (msg.type === 'edicao' || msg.type === 'edicoes') {
    const planet = planets.get(msg.planetId);
    if (!planet) return;
    if (msg.type === 'edicoes') planet.campo.definir(msg.lista);
    else planet.campo.aplicar(msg.edicao);
    return;
  }

  if (msg.type === 'build') {
    const planet = planets.get(msg.planetId);
    if (!planet) return;
    const result = buildChunk(msg, planet.cfg, planet.sampler, planet.campo);
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

function buildChunk(req, cfg, sampler, campo) {
  const { id, face, u0, v0, size, withProps } = req;

  // -----------------------------------------------------------------------
  // Recorte das escavações que alcançam ESTE chunk.
  //
  // Feito uma vez aqui, antes do laço de milhares de vértices. Sem isso, cada
  // vértice pagaria um produto escalar por edição existente no planeta — o
  // custo de gerar terreno cresceria com o quanto o mundo já foi cavado, mesmo
  // do outro lado do globo.
  //
  // O raio angular é o do chunk (`size` cobre 1/4 de face ≈ 90°) com folga:
  // uma edição que só encosta na borda ainda precisa entrar, senão aparece um
  // degrau exatamente na costura entre dois chunks.
  // -----------------------------------------------------------------------
  const dirCentro = [0, 0, 0];
  faceDirection(face, u0 + size * 0.5, v0 + size * 0.5, dirCentro);
  sampler.usarCampo(
    campo.lista.length === 0 ? campo : campo.paraRegiao(dirCentro, size * 1.6)
  );

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
  // Só o centro do chunk: as posições saem relativas a ele, como as do terreno.
  // A grade amostrada NÃO entra mais — ver o cabeçalho de `scatterProps`.
  const props = withProps ? scatterProps(req, cfg, sampler, { cx, cy, cz }) : new Float32Array(0);

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

/** Espaçamento médio entre candidatos a prop, em unidades de mundo. */
const ESPACAMENTO_PROPS = 4.0;

/**
 * Maior soma de pesos possível entre todos os biomas, com folga.
 *
 * Serve só para rejeitar candidatos ANTES de amostrar o terreno: um sorteio
 * acima disto não vira prop em bioma nenhum, então não vale pagar três
 * avaliações de ruído para descobrir isso. Se algum bioma passar deste total,
 * o efeito é apenas props a menos — nunca props no lugar errado.
 */
const PESO_MAXIMO = 0.75;

/**
 * Semente de uma CÉLULA do espalhamento — não do chunk.
 *
 * É esta função que torna a vegetação estável: a mesma célula devolve a mesma
 * semente independentemente de qual chunk (e de qual nível de LOD) esteja
 * perguntando.
 */
function sementeDaCelula(planetId, face, ci, cj) {
  let h = (planetId * 374761393 + face * 668265263) >>> 0;
  h = (h ^ Math.imul(ci | 0, 2246822519)) >>> 0;
  h = (h ^ Math.imul(cj | 0, 3266489917)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  return h >>> 0;
}

/**
 * Distribui vegetação/rochas/depósitos sobre o chunk.
 *
 * ===========================================================================
 * O ESPALHAMENTO É DO LUGAR, NÃO DO CHUNK
 * ===========================================================================
 * Esta função já foi escrita da maneira óbvia: sortear N candidatos DENTRO do
 * chunk, com uma semente derivada do chunk, lendo a grade que ele já amostrou.
 * Era rápida e estava errada, de um jeito que só aparece em movimento.
 *
 * Um pedaço de terreno é coberto por um chunk diferente a cada nível de LOD. Se
 * a semente, a contagem de células e as posições vêm do CHUNK, então o conjunto
 * de props de um chunk de nível 7 e o dos seus quatro filhos de nível 8 são
 * conjuntos DIFERENTES sobre o mesmo chão. E a quadtree troca de nível o tempo
 * todo, a cada passo do jogador: o resultado é a vegetação inteira sendo
 * substituída por outra a cada fronteira cruzada — arbustos trocando de lugar,
 * árvores sumindo e nascendo dois metros ao lado. Era o "props pulando".
 *
 * A correção é ancorar o sorteio numa grade GLOBAL da face, com célula de
 * tamanho fixo em unidades de mundo. Cada célula tem uma semente própria e
 * produz um candidato; o chunk apenas ENUMERA as células que caem dentro dele.
 * Duas coberturas diferentes do mesmo chão enxergam as mesmas células, com as
 * mesmas sementes, nas mesmas posições — e trocar de LOD deixa de ter efeito
 * visível.
 *
 * ===========================================================================
 * POR QUE VOLTAR A AMOSTRAR O TERRENO
 * ===========================================================================
 * A versão anterior lia a grade do chunk, o que ARREDONDA a posição do prop
 * para o vértice mais próximo — e esse vértice é outro em cada nível de LOD.
 * Ou seja: mesmo com a grade global, o prop ainda saltaria alguns metros ao
 * subdividir, e um arbusto perto de um limite de bioma poderia virar pedra.
 *
 * Amostrar o ponto exato custa três avaliações do campo (elevação e duas
 * tangentes para o declive) por candidato aprovado. Nos níveis com props isso
 * dá ~360 avaliações no pior caso, contra as ~1200 que a grade do próprio chunk
 * já paga — cerca de 30% a mais num chunk, em troca de vegetação que não se
 * mexe. O sorteio grosseiro (`PESO_MAXIMO`) derruba boa parte dos candidatos
 * antes disso.
 */
function scatterProps(req, cfg, sampler, grid) {
  const { face, u0, v0, size, planetId } = req;
  const { cx, cy, cz } = grid;

  // Lado da célula em espaço paramétrico da face: `u` de 0 a 1 cobre 2·raio
  // unidades de mundo, a mesma conversão que `chunkWorldSize` usa.
  const passo = ESPACAMENTO_PROPS / (2 * cfg.radius);

  const i0 = Math.floor(u0 / passo);
  const i1 = Math.floor((u0 + size) / passo);
  const j0 = Math.floor(v0 / passo);
  const j1 = Math.floor((v0 + size) / passo);

  const out = [];
  const dir = [0, 0, 0];
  const tan = [0, 0, 0];
  const bit = [0, 0, 0];
  const desl = [0, 0, 0];

  for (let cj = j0; cj <= j1; cj++) {
    for (let ci = i0; ci <= i1; ci++) {
      const rand = mulberry32(sementeDaCelula(planetId, face, ci, cj));

      const u = (ci + rand()) * passo;
      const v = (cj + rand()) * passo;

      // ---------------------------------------------------------------
      // CADA CÉLULA TEM UM DONO SÓ.
      //
      // As células da borda são enumeradas por dois chunks vizinhos, mas o
      // ponto sorteado cai dentro de um só. O intervalo é semiaberto nos dois
      // eixos, então nenhuma célula fica sem dono nem ganha dois — que
      // apareceria como vegetação duplicada e z-fighting na costura.
      // ---------------------------------------------------------------
      if (u < u0 || u >= u0 + size || v < v0 || v >= v0 + size) continue;

      // O sorteio do tipo vem ANTES de amostrar o terreno, e é sempre
      // consumido: a sequência aleatória da célula precisa avançar igual em
      // todos os chunks que a enumerem, senão a estabilidade se perde.
      const roll = rand();
      const escalaRand = rand();
      const giro = rand();
      const matiz = rand();
      const raro = rand();
      if (roll > PESO_MAXIMO) continue;

      faceDirection(face, u, v, dir);
      const elev = sampler.heightAt(dir[0], dir[1], dir[2]);

      // Nada nasce debaixo d'água.
      if (cfg.hasWater && elev < 0) continue;

      // --- Declive por diferenças finitas em duas tangentes ----------------
      tan[0] = -dir[1]; tan[1] = dir[0]; tan[2] = 0;
      let comp = Math.hypot(tan[0], tan[1], tan[2]);
      if (comp < 1e-8) { tan[0] = 1; tan[1] = 0; tan[2] = 0; comp = 1; }
      tan[0] /= comp; tan[1] /= comp; tan[2] /= comp;

      bit[0] = dir[1] * tan[2] - dir[2] * tan[1];
      bit[1] = dir[2] * tan[0] - dir[0] * tan[2];
      bit[2] = dir[0] * tan[1] - dir[1] * tan[0];

      const eps = 0.0004;
      desl[0] = dir[0] + tan[0] * eps; desl[1] = dir[1] + tan[1] * eps; desl[2] = dir[2] + tan[2] * eps;
      const hA = sampler.heightAt(desl[0], desl[1], desl[2]);
      desl[0] = dir[0] + bit[0] * eps; desl[1] = dir[1] + bit[1] * eps; desl[2] = dir[2] + bit[2] * eps;
      const hB = sampler.heightAt(desl[0], desl[1], desl[2]);

      const corrida = cfg.radius * eps;
      const slope = Math.min(1, Math.hypot(hA - elev, hB - elev) / (corrida || 1));

      const biome = sampler.biomeAt(dir[0], dir[1], dir[2], elev, slope);
      const scatter = biomeScatter(biome, cfg.type);

      let type = -1;
      let acc = 0;
      for (let t = 0; t < scatter.weights.length; t++) {
        acc += scatter.weights[t];
        if (roll < acc) { type = t; break; }
      }
      if (type < 0) continue;
      // Encostas íngremes só seguram rocha.
      if (slope > 0.45 && type !== PROP_TYPE.ROCK) continue;
      // Depósitos são raros de propósito: são o objetivo da exploração.
      if (type === PROP_TYPE.DEPOSIT && raro > 0.16) continue;

      const r = cfg.radius + elev;
      out.push(
        dir[0] * r - cx,
        dir[1] * r - cy,
        dir[2] * r - cz,
        // Escala ABSOLUTA: um arbusto tem o mesmo tamanho independente do
        // nível de LOD do chunk em que caiu. Escalar pelo tamanho do chunk
        // faria a mesma planta encolher ao se aproximar dela.
        scatter.scale[type] * (0.7 + escalaRand * 0.6),
        giro * Math.PI * 2,
        type,
        matiz,
        // Índice do recurso: fixo por planeta para depósitos, para que o
        // jogador aprenda "este mundo tem X".
        (cfg.seed + type) % 4
      );
    }
  }

  return new Float32Array(out);
}
