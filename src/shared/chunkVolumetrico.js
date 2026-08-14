/**
 * Malha um chunk de terreno volumétrico sobre uma GRADE ESFÉRICA.
 *
 * ===========================================================================
 * POR QUE ESFÉRICA, E NÃO UMA CAIXA
 * ===========================================================================
 * A escolha parece um detalhe e é a diferença entre viável e inviável. Medido
 * neste projeto, com o planeta de seed 7:
 *
 *   `heightAt` custa 0,88 µs por chamada (são ~20 oitavas de ruído somadas).
 *
 *   Numa grade CARTESIANA de 43³ ele é chamado uma vez por amostra:
 *   79.507 chamadas, 70 ms por chunk. Inviável — o jogo gera centenas de
 *   chunks e o orçamento inteiro de um quadro é 16 ms.
 *
 *   Numa grade ESFÉRICA a altura da superfície depende só da DIREÇÃO. Todas as
 *   amostras de uma mesma coluna radial compartilham a direção, então basta uma
 *   chamada por coluna: 1.849, 1,6 ms. Quarenta e três vezes menos.
 *
 * O segundo motivo é estrutural: o jogo inteiro já é organizado em cubo-esfera
 * com `(face, u, v)`, e a quadtree existente subdivide exatamente nesses eixos.
 * Uma grade esférica mantém isso e acrescenta só o eixo radial — o que torna o
 * passo seguinte (subdivisão em profundidade) um acréscimo, e não outra
 * reescrita.
 *
 * ===========================================================================
 * O QUE A GRADE COBRE
 * ===========================================================================
 * Um chunk é um tronco: a região angular `(u0..u0+size, v0..v0+size)` da face,
 * entre dois raios. Os raios são escolhidos a partir da faixa de elevação
 * observada NAQUELA região, com folga para os túneis — não do planeta inteiro,
 * senão a casca teria centenas de unidades de espessura em toda parte.
 */

import { faceDirection } from './terrain.js';

/**
 * Passo radial GLOBAL, em unidades de mundo.
 *
 * Fixo de propósito: é o que faz dois chunks vizinhos amostrarem exatamente os
 * mesmos raios e a costura entre eles fechar. Ver a nota longa em `rMin`.
 */
const PASSO_RADIAL = 4.75;
import { malharCampo } from './marchingCubes.js';

/**
 * @param {object} o
 * @param {object} o.cfg config do planeta
 * @param {{densidadeEm:Function, superficieEm:Function}} o.campo campo de densidade
 * @param {number} o.face 0..5
 * @param {number} o.u0 canto da região na face, em [0,1]
 * @param {number} o.v0
 * @param {number} o.size aresta angular da região, fração da face
 * @param {number} o.resAngular células ao longo de u e de v
 * @param {number} o.resRadial células ao longo do raio
 * @param {number} [o.profundidadeDe] início da faixa, em unidades ABAIXO da
 *   superfície local (negativo = acima dela)
 * @param {number} [o.profundidadeAte] fim da faixa, em unidades abaixo
 */
export function malharChunkVolumetrico({
  cfg,
  campo,
  face,
  u0,
  v0,
  size,
  resAngular = 32,
  resRadial = 24,
  profundidadeDe = -12,
  profundidadeAte = 90,
}) {
  const na = resAngular;
  // `resRadial` vira apenas uma dica: o número real de camadas sai do relevo
  // local dividido pelo passo GLOBAL (ver a nota adiante).
  let nr = resRadial;
  // Uma camada extra de cada lado, para o gradiente das normais na borda.
  const ladoA = na + 3;
  const passoAng = size / na;

  // -------------------------------------------------------------------------
  // 1. Direções e altura da superfície, UMA VEZ por coluna angular.
  //
  // É esta tabela que paga a conta cara. Tudo abaixo a reaproveita.
  // -------------------------------------------------------------------------
  const dirs = new Float32Array(ladoA * ladoA * 3);
  const alturas = new Float64Array(ladoA * ladoA);
  const dir = [0, 0, 0];
  let hMin = Infinity;
  let hMax = -Infinity;

  for (let b = 0; b < ladoA; b++) {
    const v = v0 + (b - 1) * passoAng;
    for (let a = 0; a < ladoA; a++) {
      const u = u0 + (a - 1) * passoAng;
      faceDirection(face, u, v, dir);
      const i = b * ladoA + a;
      dirs[i * 3] = dir[0];
      dirs[i * 3 + 1] = dir[1];
      dirs[i * 3 + 2] = dir[2];
      const h = campo.superficieEm(dir[0], dir[1], dir[2]);
      alturas[i] = h;
      // Só o interior manda na faixa radial: as camadas de borda extrapolam
      // para fora do chunk e puxariam a casca para longe sem necessidade.
      if (a > 0 && a < ladoA - 1 && b > 0 && b < ladoA - 1) {
        if (h < hMin) hMin = h;
        if (h > hMax) hMax = h;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2. Faixa radial coberta pela casca.
  //
  // A faixa é expressa em PROFUNDIDADE abaixo da superfície local, e não em
  // raios absolutos. É a coordenada natural do problema: as cavernas são
  // definidas por profundidade (ver `margemTeto` e `profundidadeMaxima` em
  // `densidade.js`), e um relevo que varia 200 unidades dentro do chunk faria
  // uma faixa absoluta cobrir a superfície num canto e o subsolo no outro.
  //
  // A faixa 0 vai de 12 acima da elevação MÁXIMA até 90 abaixo da MÍNIMA — que
  // é o comportamento de sempre. Faixas mais fundas usam o mesmo referencial e
  // se encaixam sem sobreposição.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // A RETÍCULA RADIAL É GLOBAL, E ISSO FECHA A COSTURA.
  //
  // A primeira versão derivava o passo da faixa DESTE chunk:
  // `(rMax - rMin) / nr`. Cada chunk tem o próprio relevo, logo o próprio rMin
  // e o próprio passo — e dois vizinhos amostravam raios diferentes. Medido
  // entre dois chunks lado a lado:
  //
  //   A: 4299,26  4303,91  4308,55  ...  (passo 4,649)
  //   B: 4299,92  4304,70  4309,48  ...  (passo 4,777)
  //
  // Como os vértices saem de interpolação ENTRE amostras, retículas diferentes
  // produzem vértices em raios diferentes no plano de contato: a costura não
  // fecha, e sobra uma fenda por onde se vê o vazio. Nenhum vértice de borda
  // coincidia com o do vizinho.
  //
  // Com o passo fixo e o início ancorado num múltiplo dele, dois chunks
  // quaisquer amostram exatamente os mesmos raios. O número de camadas passa a
  // variar com o relevo local, que é o preço — e é barato.
  // -------------------------------------------------------------------------
  const rMinBruto = hMin - profundidadeAte;
  const rMinAlinhado = Math.floor(rMinBruto / PASSO_RADIAL) * PASSO_RADIAL;
  const camadas = Math.max(
    4,
    Math.ceil((hMax - profundidadeDe - rMinAlinhado) / PASSO_RADIAL)
  );
  const rMin = rMinAlinhado;
  const passoRad = PASSO_RADIAL;
  const rMax = rMin + camadas * passoRad;

  // A partir daqui o número de camadas é o calculado, não o pedido.
  nr = camadas;
  const ladoRFinal = nr + 3;

  /** Posição de mundo de um nó `(a, b, r)` da grade. */
  const posicaoDe = (a, b, r, saida) => {
    // Preso às bordas: as camadas extras do gradiente pedem índices -1 e n+2,
    // e sem o clamp elas leriam fora da tabela de direções.
    const ai = a < 0 ? 0 : a >= ladoA ? ladoA - 1 : a;
    const bi = b < 0 ? 0 : b >= ladoA ? ladoA - 1 : b;
    const i = (bi * ladoA + ai) * 3;
    const raio = rMin + (r - 1) * passoRad;
    saida[0] = dirs[i] * raio;
    saida[1] = dirs[i + 1] * raio;
    saida[2] = dirs[i + 2] * raio;
  };

  // -------------------------------------------------------------------------
  // 3. Densidade em cada nó.
  //
  // A parte cara — a altura da superfície — vem da tabela. O que sobra por
  // amostra é uma subtração e, abaixo da superfície, o termo de cavernas.
  // -------------------------------------------------------------------------
  const total = ladoA * ladoA * ladoRFinal;
  const grade = new Float32Array(total);
  const p = [0, 0, 0];

  for (let r = 0; r < ladoRFinal; r++) {
    const raio = rMin + (r - 1) * passoRad;
    for (let b = 0; b < ladoA; b++) {
      for (let a = 0; a < ladoA; a++) {
        const col = b * ladoA + a;
        const i3 = col * 3;
        p[0] = dirs[i3] * raio;
        p[1] = dirs[i3 + 1] * raio;
        p[2] = dirs[i3 + 2] * raio;
        // `densidadeComAltura`, e não `densidadeEm`: a altura já está na tabela
        // e recalculá-la aqui custaria ~20 oitavas de ruído POR AMOSTRA. É a
        // linha que separa 47 ms de 3 ms por chunk.
        grade[(r * ladoA + b) * ladoA + a] = campo.densidadeComAltura(
          p[0], p[1], p[2], alturas[col], raio
        );
      }
    }
  }

  // O mesher indexa `(i, j, k)` numa grade cúbica de lado `n+3`. A nossa tem
  // dois lados angulares iguais e um radial diferente, então a chamada usa o
  // maior e a leitura é remapeada — ver `campoRemapeado`.
  const n = Math.max(na, nr);
  const lado = n + 3;
  const campoRemapeado = new Float32Array(lado * lado * lado);
  // Preenche com "ar" (positivo) para que as células fora da região real nunca
  // gerem superfície: densidade positiva em todos os cantos é o caso 0.
  campoRemapeado.fill(1e6);
  for (let r = 0; r < ladoRFinal; r++) {
    for (let b = 0; b < ladoA; b++) {
      for (let a = 0; a < ladoA; a++) {
        campoRemapeado[(r * lado + b) * lado + a] = grade[(r * ladoA + b) * ladoA + a];
      }
    }
  }

  const malha = malharCampo({
    campo: campoRemapeado,
    n,
    posicaoDe,
  });

  const comSaia = costurarSaia(malha, PASSO_RADIAL * 1.6);

  return { ...comSaia, rMin, rMax, hMin, hMax, colunas: ladoA * ladoA, amostras: total };
}

/**
 * Acrescenta uma SAIA nas bordas abertas da malha.
 *
 * ===========================================================================
 * O QUE ELA RESOLVE
 * ===========================================================================
 * Entre chunks do MESMO nível a costura fecha exatamente — medido: as posições
 * coincidem e as normais divergem 0,01 grau. Entre níveis DIFERENTES não fecha,
 * e não tem como fechar: o chunk fino tem o dobro de amostras angulares na
 * borda, então há vértices dele sem correspondente do lado grosso. É o vértice
 * em T clássico, e a fresta aparece como uma linha de chunk na paisagem.
 *
 * A saída canônica é o transvoxel, que gera células de transição próprias. É
 * bastante código e uma tabela nova. A saia é o que o caminho de campo de altura
 * já usa neste projeto: em vez de casar as bordas, ESCONDE a fresta baixando
 * uma cortina de geometria por trás dela.
 *
 * Não é elegante e é honesta sobre o que faz — a fresta continua existindo, só
 * que atrás dela há terreno em vez de espaço vazio, e o olho não distingue.
 *
 * ===========================================================================
 * COMO
 * ===========================================================================
 * Uma aresta de BORDA é usada por um triângulo só. Numa malha de marching cubes
 * fechada, as únicas bordas abertas são as das paredes do chunk. Cada uma é
 * estendida radialmente para DENTRO do planeta, formando um quadrilátero.
 *
 * A orientação vem da aresta dirigida do triângulo dono, e não de uma escolha
 * arbitrária: assim a saia herda o lado de fora da superfície que a gerou, em
 * vez de aparecer preta por estar virada ao contrário.
 *
 * @param {{positions:Float32Array, normals:Float32Array, indices:Uint32Array}} malha
 * @param {number} profundidade quanto a cortina desce, em unidades
 */
function costurarSaia(malha, profundidade) {
  const { positions, normals, indices } = malha;

  // Arestas dirigidas: a que não tiver a oposta é borda.
  const vistas = new Set();
  for (let t = 0; t < indices.length; t += 3) {
    vistas.add(indices[t] * 4294967296 + indices[t + 1]);
    vistas.add(indices[t + 1] * 4294967296 + indices[t + 2]);
    vistas.add(indices[t + 2] * 4294967296 + indices[t]);
  }

  const bordas = [];
  for (const chave of vistas) {
    const a = Math.floor(chave / 4294967296);
    const b = chave % 4294967296;
    if (!vistas.has(b * 4294967296 + a)) bordas.push(a, b);
  }
  if (bordas.length === 0) return malha;

  const nOrig = positions.length / 3;
  // Um vértice novo por vértice de borda, reaproveitado entre arestas vizinhas.
  const mapa = new Map();
  const posExtra = [];
  const nrmExtra = [];

  const rebaixado = (i) => {
    const existente = mapa.get(i);
    if (existente !== undefined) return existente;
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const r = Math.hypot(x, y, z) || 1;
    const k = nOrig + posExtra.length / 3;
    posExtra.push(
      x - (x / r) * profundidade,
      y - (y / r) * profundidade,
      z - (z / r) * profundidade
    );
    // A normal é herdada do vértice de cima: a saia é uma cortina, e dar-lhe
    // normal própria a faria acender de forma diferente do terreno que ela
    // continua — o que criaria a linha que ela existe para esconder.
    nrmExtra.push(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
    mapa.set(i, k);
    return k;
  };

  const idxExtra = [];
  for (let e = 0; e < bordas.length; e += 2) {
    const a = bordas[e], b = bordas[e + 1];
    const a2 = rebaixado(a), b2 = rebaixado(b);
    idxExtra.push(a, b, b2, a, b2, a2);
  }

  const pos = new Float32Array(positions.length + posExtra.length);
  pos.set(positions); pos.set(posExtra, positions.length);
  const nrm = new Float32Array(normals.length + nrmExtra.length);
  nrm.set(normals); nrm.set(nrmExtra, normals.length);
  const idx = new Uint32Array(indices.length + idxExtra.length);
  idx.set(indices); idx.set(idxExtra, indices.length);

  return { positions: pos, normals: nrm, indices: idx };
}
