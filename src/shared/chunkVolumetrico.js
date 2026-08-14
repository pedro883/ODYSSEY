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
  const nr = resRadial;
  // Uma camada extra de cada lado, para o gradiente das normais na borda.
  const ladoA = na + 3;
  const ladoR = nr + 3;
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
  const rMax = hMax - profundidadeDe;
  const rMin = hMin - profundidadeAte;
  const passoRad = (rMax - rMin) / nr;

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
  const total = ladoA * ladoA * ladoR;
  const grade = new Float32Array(total);
  const p = [0, 0, 0];

  for (let r = 0; r < ladoR; r++) {
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
  for (let r = 0; r < ladoR; r++) {
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

  return { ...malha, rMin, rMax, hMin, hMax, colunas: ladoA * ladoA, amostras: total };
}
