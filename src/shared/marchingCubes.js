/**
 * Marching cubes: extrai a malha da superfície de nível zero de um campo.
 *
 * ===========================================================================
 * O ALGORITMO EM UMA FRASE
 * ===========================================================================
 * Divide-se o espaço em cubos; em cada cubo, olha-se o SINAL da densidade nos
 * oito cantos. Isso dá 8 bits, 256 configurações, e cada configuração determina
 * quais arestas do cubo a superfície atravessa e como ligá-las em triângulos.
 * O vértice sobre cada aresta é posicionado por interpolação linear entre os
 * dois cantos, o que faz a malha acompanhar o campo em vez de ficar em degraus
 * de voxel.
 *
 * ===========================================================================
 * AS TABELAS
 * ===========================================================================
 * `ARESTAS` diz, para cada uma das 256 configurações, quais das 12 arestas são
 * cortadas (um bitmask). `TRIANGULOS` diz como ligar esses pontos, em ternas,
 * terminando em -1. São as tabelas clássicas de Paul Bourke; estão aqui
 * literalmente porque derivá-las em tempo de execução custaria mais código do
 * que copiá-las e daria a mesma coisa.
 *
 * ===========================================================================
 * DECISÕES QUE VALEM REGISTRO
 * ===========================================================================
 * 1. O CAMPO É AMOSTRADO NUMA GRADE COM BORDA. Para malhar N³ células é preciso
 *    (N+1)³ amostras dos cantos — e, para calcular normais por diferenças
 *    finitas sem reamostrar, mais uma camada em volta. Amostrar sob demanda
 *    dentro do laço reavaliaria cada canto até oito vezes.
 *
 * 2. AS NORMAIS VÊM DO GRADIENTE DO CAMPO, não da face do triângulo. Normal de
 *    face dá o aspecto facetado clássico do marching cubes; o gradiente do
 *    campo é a normal verdadeira da superfície e sai suave de graça. Como já
 *    temos a grade amostrada, o gradiente custa uma subtração por eixo.
 *
 * 3. VÉRTICES SÃO COMPARTILHADOS POR ARESTA, via um mapa de aresta para índice.
 *    Sem isso cada triângulo traz três vértices próprios e a malha fica com 3x
 *    a contagem, sem suavização possível.
 */

/* ===========================================================================
   Tabelas de Paul Bourke
   =========================================================================== */

// prettier-ignore
const ARESTAS = new Uint16Array([
0x0,0x109,0x203,0x30a,0x406,0x50f,0x605,0x70c,0x80c,0x905,0xa0f,0xb06,0xc0a,0xd03,0xe09,0xf00,
0x190,0x99,0x393,0x29a,0x596,0x49f,0x795,0x69c,0x99c,0x895,0xb9f,0xa96,0xd9a,0xc93,0xf99,0xe90,
0x230,0x339,0x33,0x13a,0x636,0x73f,0x435,0x53c,0xa3c,0xb35,0x83f,0x936,0xe3a,0xf33,0xc39,0xd30,
0x3a0,0x2a9,0x1a3,0xaa,0x7a6,0x6af,0x5a5,0x4ac,0xbac,0xaa5,0x9af,0x8a6,0xfaa,0xea3,0xda9,0xca0,
0x460,0x569,0x663,0x76a,0x66,0x16f,0x265,0x36c,0xc6c,0xd65,0xe6f,0xf66,0x86a,0x963,0xa69,0xb60,
0x5f0,0x4f9,0x7f3,0x6fa,0x1f6,0xff,0x3f5,0x2fc,0xdfc,0xcf5,0xfff,0xef6,0x9fa,0x8f3,0xbf9,0xaf0,
0x650,0x759,0x453,0x55a,0x256,0x35f,0x55,0x15c,0xe5c,0xf55,0xc5f,0xd56,0xa5a,0xb53,0x859,0x950,
0x7c0,0x6c9,0x5c3,0x4ca,0x3c6,0x2cf,0x1c5,0xcc,0xfcc,0xec5,0xdcf,0xcc6,0xbca,0xac3,0x9c9,0x8c0,
0x8c0,0x9c9,0xac3,0xbca,0xcc6,0xdcf,0xec5,0xfcc,0xcc,0x1c5,0x2cf,0x3c6,0x4ca,0x5c3,0x6c9,0x7c0,
0x950,0x859,0xb53,0xa5a,0xd56,0xc5f,0xf55,0xe5c,0x15c,0x55,0x35f,0x256,0x55a,0x453,0x759,0x650,
0xaf0,0xbf9,0x8f3,0x9fa,0xef6,0xfff,0xcf5,0xdfc,0x2fc,0x3f5,0xff,0x1f6,0x6fa,0x7f3,0x4f9,0x5f0,
0xb60,0xa69,0x963,0x86a,0xf66,0xe6f,0xd65,0xc6c,0x36c,0x265,0x16f,0x66,0x76a,0x663,0x569,0x460,
0xca0,0xda9,0xea3,0xfaa,0x8a6,0x9af,0xaa5,0xbac,0x4ac,0x5a5,0x6af,0x7a6,0xaa,0x1a3,0x2a9,0x3a0,
0xd30,0xc39,0xf33,0xe3a,0x936,0x83f,0xb35,0xa3c,0x53c,0x435,0x73f,0x636,0x13a,0x33,0x339,0x230,
0xe90,0xf99,0xc93,0xd9a,0xa96,0xb9f,0x895,0x99c,0x69c,0x795,0x49f,0x596,0x29a,0x393,0x99,0x190,
0xf00,0xe09,0xd03,0xc0a,0xb06,0xa0f,0x905,0x80c,0x70c,0x605,0x50f,0x406,0x30a,0x203,0x109,0x0,
]);

// prettier-ignore
const TRIANGULOS = [
[],[0,8,3],[0,1,9],[1,8,3,9,8,1],[1,2,10],[0,8,3,1,2,10],[9,2,10,0,2,9],[2,8,3,2,10,8,10,9,8],
[3,11,2],[0,11,2,8,11,0],[1,9,0,2,3,11],[1,11,2,1,9,11,9,8,11],[3,10,1,11,10,3],[0,10,1,0,8,10,8,11,10],
[3,9,0,3,11,9,11,10,9],[9,8,10,10,8,11],[4,7,8],[4,3,0,7,3,4],[0,1,9,8,4,7],[4,1,9,4,7,1,7,3,1],
[1,2,10,8,4,7],[3,4,7,3,0,4,1,2,10],[9,2,10,9,0,2,8,4,7],[2,10,9,2,9,7,2,7,3,7,9,4],
[8,4,7,3,11,2],[11,4,7,11,2,4,2,0,4],[9,0,1,8,4,7,2,3,11],[4,7,11,9,4,11,9,11,2,9,2,1],
[3,10,1,3,11,10,7,8,4],[1,11,10,1,4,11,1,0,4,7,11,4],[4,7,8,9,0,11,9,11,10,11,0,3],
[4,7,11,4,11,9,9,11,10],[9,5,4],[9,5,4,0,8,3],[0,5,4,1,5,0],[8,5,4,8,3,5,3,1,5],
[1,2,10,9,5,4],[3,0,8,1,2,10,4,9,5],[5,2,10,5,4,2,4,0,2],[2,10,5,3,2,5,3,5,4,3,4,8],
[9,5,4,2,3,11],[0,11,2,0,8,11,4,9,5],[0,5,4,0,1,5,2,3,11],[2,1,5,2,5,8,2,8,11,4,8,5],
[10,3,11,10,1,3,9,5,4],[4,9,5,0,8,1,8,10,1,8,11,10],[5,4,0,5,0,11,5,11,10,11,0,3],
[5,4,8,5,8,10,10,8,11],[9,7,8,5,7,9],[9,3,0,9,5,3,5,7,3],[0,7,8,0,1,7,1,5,7],[1,5,3,3,5,7],
[9,7,8,9,5,7,10,1,2],[10,1,2,9,5,0,5,3,0,5,7,3],[8,0,2,8,2,5,8,5,7,10,5,2],[2,10,5,2,5,3,3,5,7],
[7,9,5,7,8,9,3,11,2],[9,5,7,9,7,2,9,2,0,2,7,11],[2,3,11,0,1,8,1,7,8,1,5,7],[11,2,1,11,1,7,7,1,5],
[9,5,8,8,5,7,10,1,3,10,3,11],[5,7,0,5,0,9,7,11,0,1,0,10,11,10,0],[11,10,0,11,0,3,10,5,0,8,0,7,5,7,0],
[11,10,5,7,11,5],[10,6,5],[0,8,3,5,10,6],[9,0,1,5,10,6],[1,8,3,1,9,8,5,10,6],[1,6,5,2,6,1],
[1,6,5,1,2,6,3,0,8],[9,6,5,9,0,6,0,2,6],[5,9,8,5,8,2,5,2,6,3,2,8],[2,3,11,10,6,5],
[11,0,8,11,2,0,10,6,5],[0,1,9,2,3,11,5,10,6],[5,10,6,1,9,2,9,11,2,9,8,11],[6,3,11,6,5,3,5,1,3],
[0,8,11,0,11,5,0,5,1,5,11,6],[3,11,6,0,3,6,0,6,5,0,5,9],[6,5,9,6,9,11,11,9,8],[5,10,6,4,7,8],
[4,3,0,4,7,3,6,5,10],[1,9,0,5,10,6,8,4,7],[10,6,5,1,9,7,1,7,3,7,9,4],[6,1,2,6,5,1,4,7,8],
[1,2,5,5,2,6,3,0,4,3,4,7],[8,4,7,9,0,5,0,6,5,0,2,6],[7,3,9,7,9,4,3,2,9,5,9,6,2,6,9],
[3,11,2,7,8,4,10,6,5],[5,10,6,4,7,2,4,2,0,2,7,11],[0,1,9,4,7,8,2,3,11,5,10,6],
[9,2,1,9,11,2,9,4,11,7,11,4,5,10,6],[8,4,7,3,11,5,3,5,1,5,11,6],[5,1,11,5,11,6,1,0,11,7,11,4,0,4,11],
[0,5,9,0,6,5,0,3,6,11,6,3,8,4,7],[6,5,9,6,9,11,4,7,9,7,11,9],[10,4,9,6,4,10],[4,10,6,4,9,10,0,8,3],
[10,0,1,10,6,0,6,4,0],[8,3,1,8,1,6,8,6,4,6,1,10],[1,4,9,1,2,4,2,6,4],[3,0,8,1,2,9,2,4,9,2,6,4],
[0,2,4,4,2,6],[8,3,2,8,2,4,4,2,6],[10,4,9,10,6,4,11,2,3],[0,8,2,2,8,11,4,9,10,4,10,6],
[3,11,2,0,1,6,0,6,4,6,1,10],[6,4,1,6,1,10,4,8,1,2,1,11,8,11,1],[9,6,4,9,3,6,9,1,3,11,6,3],
[8,11,1,8,1,0,11,6,1,9,1,4,6,4,1],[3,11,6,3,6,0,0,6,4],[6,4,8,11,6,8],[7,10,6,7,8,10,8,9,10],
[0,7,3,0,10,7,0,9,10,6,7,10],[10,6,7,1,10,7,1,7,8,1,8,0],[10,6,7,10,7,1,1,7,3],
[1,2,6,1,6,8,1,8,9,8,6,7],[2,6,9,2,9,1,6,7,9,0,9,3,7,3,9],[7,8,0,7,0,6,6,0,2],[7,3,2,6,7,2],
[2,3,11,10,6,8,10,8,9,8,6,7],[2,0,7,2,7,11,0,9,7,6,7,10,9,10,7],[1,8,0,1,7,8,1,10,7,6,7,10,2,3,11],
[11,2,1,11,1,7,10,6,1,6,7,1],[8,9,6,8,6,7,9,1,6,11,6,3,1,3,6],[0,9,1,11,6,7],
[7,8,0,7,0,6,3,11,0,11,6,0],[7,11,6],[7,6,11],[3,0,8,11,7,6],[0,1,9,11,7,6],[8,1,9,8,3,1,11,7,6],
[10,1,2,6,11,7],[1,2,10,3,0,8,6,11,7],[2,9,0,2,10,9,6,11,7],[6,11,7,2,10,3,10,8,3,10,9,8],
[7,2,3,6,2,7],[7,0,8,7,6,0,6,2,0],[2,7,6,2,3,7,0,1,9],[1,6,2,1,8,6,1,9,8,8,7,6],
[10,7,6,10,1,7,1,3,7],[10,7,6,1,7,10,1,8,7,1,0,8],[0,3,7,0,7,10,0,10,9,6,10,7],
[7,6,10,7,10,8,8,10,9],[6,8,4,11,8,6],[3,6,11,3,0,6,0,4,6],[8,6,11,8,4,6,9,0,1],
[9,4,6,9,6,3,9,3,1,11,3,6],[6,8,4,6,11,8,2,10,1],[1,2,10,3,0,11,0,6,11,0,4,6],
[4,11,8,4,6,11,0,2,9,2,10,9],[10,9,3,10,3,2,9,4,3,11,3,6,4,6,3],[8,2,3,8,4,2,4,6,2],
[0,4,2,4,6,2],[1,9,0,2,3,4,2,4,6,4,3,8],[1,9,4,1,4,2,2,4,6],[8,1,3,8,6,1,8,4,6,6,10,1],
[10,1,0,10,0,6,6,0,4],[4,6,3,4,3,8,6,10,3,0,3,9,10,9,3],[10,9,4,6,10,4],[4,9,5,7,6,11],
[0,8,3,4,9,5,11,7,6],[5,0,1,5,4,0,7,6,11],[11,7,6,8,3,4,3,5,4,3,1,5],[9,5,4,10,1,2,7,6,11],
[6,11,7,1,2,10,0,8,3,4,9,5],[7,6,11,5,4,10,4,2,10,4,0,2],[3,4,8,3,5,4,3,2,5,10,5,2,11,7,6],
[7,2,3,7,6,2,5,4,9],[9,5,4,0,8,6,0,6,2,6,8,7],[3,6,2,3,7,6,1,5,0,5,4,0],
[6,2,8,6,8,7,2,1,8,4,8,5,1,5,8],[9,5,4,10,1,6,1,7,6,1,3,7],[1,6,10,1,7,6,1,0,7,8,7,0,9,5,4],
[4,0,10,4,10,5,0,3,10,6,10,7,3,7,10],[7,6,10,7,10,8,5,4,10,4,8,10],[6,9,5,6,11,9,11,8,9],
[3,6,11,0,6,3,0,5,6,0,9,5],[0,11,8,0,5,11,0,1,5,5,6,11],[6,11,3,6,3,5,5,3,1],
[1,2,10,9,5,11,9,11,8,11,5,6],[0,11,3,0,6,11,0,9,6,5,6,9,1,2,10],[11,8,5,11,5,6,8,0,5,10,5,2,0,2,5],
[6,11,3,6,3,5,2,10,3,10,5,3],[5,8,9,5,2,8,5,6,2,3,8,2],[9,5,6,9,6,0,0,6,2],
[1,5,8,1,8,0,5,6,8,3,8,2,6,2,8],[1,5,6,2,1,6],[1,3,6,1,6,10,3,8,6,5,6,9,8,9,6],
[10,1,0,10,0,6,9,5,0,5,6,0],[0,3,8,5,6,10],[10,5,6],[11,5,10,7,5,11],[11,5,10,11,7,5,8,3,0],
[5,11,7,5,10,11,1,9,0],[10,7,5,10,11,7,9,8,1,8,3,1],[11,1,2,11,7,1,7,5,1],
[0,8,3,1,2,7,1,7,5,7,2,11],[9,7,5,9,2,7,9,0,2,2,11,7],[7,5,2,7,2,11,5,9,2,3,2,8,9,8,2],
[2,5,10,2,3,5,3,7,5],[8,2,0,8,5,2,8,7,5,10,2,5],[9,0,1,5,10,3,5,3,7,3,10,2],
[9,8,2,9,2,1,8,7,2,10,2,5,7,5,2],[1,3,5,3,7,5],[0,8,7,0,7,1,1,7,5],[9,0,3,9,3,5,5,3,7],
[9,8,7,5,9,7],[5,8,4,5,10,8,10,11,8],[5,0,4,5,11,0,5,10,11,11,3,0],[0,1,9,8,4,10,8,10,11,10,4,5],
[10,11,4,10,4,5,11,3,4,9,4,1,3,1,4],[2,5,1,2,8,5,2,11,8,4,5,8],[0,4,11,0,11,3,4,5,11,2,11,1,5,1,11],
[0,2,5,0,5,9,2,11,5,4,5,8,11,8,5],[9,4,5,2,11,3],[2,5,10,3,5,2,3,4,5,3,8,4],[5,10,2,5,2,4,4,2,0],
[3,10,2,3,5,10,3,8,5,4,5,8,0,1,9],[5,10,2,5,2,4,1,9,2,9,4,2],[8,4,5,8,5,3,3,5,1],[0,4,5,1,0,5],
[8,4,5,8,5,3,9,0,5,0,3,5],[9,4,5],[4,11,7,4,9,11,9,10,11],[0,8,3,4,9,7,9,11,7,9,10,11],
[1,10,11,1,11,4,1,4,0,7,4,11],[3,1,4,3,4,8,1,10,4,7,4,11,10,11,4],[4,11,7,9,11,4,9,2,11,9,1,2],
[9,7,4,9,11,7,9,1,11,2,11,1,0,8,3],[11,7,4,11,4,2,2,4,0],[11,7,4,11,4,2,8,3,4,3,2,4],
[2,9,10,2,7,9,2,3,7,7,4,9],[9,10,7,9,7,4,10,2,7,8,7,0,2,0,7],[3,7,10,3,10,2,7,4,10,1,10,0,4,0,10],
[1,10,2,8,7,4],[4,9,1,4,1,7,7,1,3],[4,9,1,4,1,7,0,8,1,8,7,1],[4,0,3,7,4,3],[4,8,7],
[9,10,8,10,11,8],[3,0,9,3,9,11,11,9,10],[0,1,10,0,10,8,8,10,11],[3,1,10,11,3,10],
[1,2,11,1,11,9,9,11,8],[3,0,9,3,9,11,1,2,9,2,11,9],[0,2,11,8,0,11],[3,2,11],
[2,3,8,2,8,10,10,8,9],[9,10,2,0,9,2],[2,3,8,2,8,10,0,1,8,1,10,8],[1,10,2],[1,3,8,9,1,8],
[0,9,1],[0,3,8],[],
];

/**
 * Os dois cantos que cada uma das 12 arestas liga, em índices de canto.
 * A numeração dos cantos é a clássica: bit 0 = (0,0,0), bit 1 = (1,0,0),
 * bit 2 = (1,1,0), bit 3 = (0,1,0), e os mesmos quatro com z = 1.
 */
const CANTOS_DA_ARESTA = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/** Deslocamento de cada canto dentro da célula. */
const CANTO = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];

/**
 * Identidade CANÔNICA de cada aresta: `[dx, dy, dz, eixo]`.
 *
 * ===========================================================================
 * POR QUE ISTO PRECISOU EXISTIR
 * ===========================================================================
 * A primeira versão identificava o vértice por `(célula, índice da aresta)`, o
 * que parece natural e está errado: a MESMA aresta do mundo pertence a até
 * QUATRO células vizinhas, com índices diferentes em cada uma. A aresta 0 da
 * célula (i,j,k) é a aresta 2 de (i,j-1,k), a 4 de (i,j,k-1) e a 6 de
 * (i,j-1,k-1).
 *
 * O resultado, medido numa esfera de teste: 10.488 vértices onde deviam ser uns
 * 2.600 — cada vértice duplicado até quatro vezes. A malha até parecia certa
 * (posições e normais estavam corretas), mas nenhuma aresta era compartilhada,
 * o que quebra a característica de Euler, impede suavização e quadruplica a
 * memória.
 *
 * A identidade certa é o ponto de rede do extremo MENOR da aresta mais o eixo
 * que ela segue. Assim as quatro células chegam à mesma chave.
 */
const ARESTA_CANONICA = [
  [0, 0, 0, 0], [1, 0, 0, 1], [0, 1, 0, 0], [0, 0, 0, 1],
  [0, 0, 1, 0], [1, 0, 1, 1], [0, 1, 1, 0], [0, 0, 1, 1],
  [0, 0, 0, 2], [1, 0, 0, 2], [1, 1, 0, 2], [0, 1, 0, 2],
];

/** Vetor unitário de cada eixo, para achar o outro extremo da aresta. */
const EIXO = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/**
 * Malha a superfície de nível zero de um campo já amostrado.
 *
 * ===========================================================================
 * GRADE CURVILÍNEA (`posicaoDe`)
 * ===========================================================================
 * Por padrão a grade é cartesiana e a posição de um nó sai de `origem + índice
 * * passo`. Passando `posicaoDe(i, j, k, saida)` ela pode ser qualquer coisa —
 * e o caso que interessa aqui é a grade ESFÉRICA, indexada por (u, v, raio)
 * sobre uma face do cubo-esfera.
 *
 * A razão é medida, não estética. O campo de densidade é dominado por
 * `heightAt`, que custa 0,88 µs (são ~20 oitavas de ruído). Numa grade
 * cartesiana de 43³ ele é chamado 79.507 vezes: 70 ms por chunk, inviável. Numa
 * grade esférica a altura da superfície depende só da DIREÇÃO, então basta uma
 * chamada por coluna angular — 1.849 no mesmo chunk, 1,6 ms. Quarenta e três
 * vezes menos.
 *
 * Com grade curvilínea as normais mudam de conta: o gradiente em espaço de
 * índice não é o gradiente em espaço de mundo, porque os três eixos da grade
 * têm escalas diferentes (um passo radial não mede o mesmo que um passo
 * angular). Ver `gradienteEm`.
 *
 * @param {object} o
 * @param {Float32Array} o.campo amostras, `(n+3)³` valores (ver `n` e a borda)
 * @param {number} o.n número de CÉLULAS por eixo (grade cúbica)
 * @param {number[]} [o.dims] células por eixo `[nx, ny, nz]`, quando a grade
 *   NÃO é cúbica; substitui `n` e evita ter de preencher o excedente
 * @param {number} [o.passo] tamanho da célula (grade cartesiana)
 * @param {number[]} [o.origem] canto mínimo da região (grade cartesiana)
 * @param {(i:number,j:number,k:number,saida:number[])=>void} [o.posicaoDe]
 *   posição de mundo de um nó da grade; substitui `passo`/`origem`
 * @returns {{positions:Float32Array, normals:Float32Array, indices:Uint32Array}}
 */
export function malharCampo({ campo, n, dims, passo, origem, posicaoDe }) {
  // A grade amostrada tem uma camada EXTRA em volta (por isso n+3 e não n+1):
  // ela existe só para o gradiente das normais nas bordas, que precisa de um
  // vizinho de cada lado. Sem ela as normais da borda do chunk sairiam
  // enviesadas e a costura entre chunks apareceria como um vinco de luz.
  //
  // -------------------------------------------------------------------------
  // EIXOS INDEPENDENTES, E POR QUE ISSO DEIXOU DE SER OPCIONAL
  // -------------------------------------------------------------------------
  // A versão anterior só aceitava grade cúbica, e quem tinha eixos diferentes
  // (a grade esférica tem dois angulares e um radial) remapeava para um cubo do
  // maior lado, preenchendo o excedente com "ar".
  //
  // Isso cria SUPERFÍCIE FALSA: onde o excedente de ar encosta na rocha real da
  // borda, o mesher vê um cruzamento e gera parede. Medido numa faixa profunda
  // sem caverna nenhuma — que deveria ser rocha maciça e devolver malha vazia —
  // saíam 1.217 vértices, todos inventados.
  // -------------------------------------------------------------------------
  const [nx, ny, nz] = dims ?? [n, n, n];
  const lx = nx + 3;
  const ly = ny + 3;
  const em = (i, j, k) => campo[(k * ly + j) * lx + i];

  const posicoes = [];
  const normais = [];
  const indices = [];

  /** Aresta já visitada -> índice do vértice, para compartilhar vértices. */
  const cache = new Map();

  // Posição de um nó da grade. Cartesiana por padrão; curvilínea quando quem
  // chama sabe mais sobre a geometria do que este arquivo (ver a nota no topo).
  const pos = posicaoDe
    ? posicaoDe
    : (i, j, k, saida) => {
        saida[0] = origem[0] + i * passo;
        saida[1] = origem[1] + j * passo;
        saida[2] = origem[2] + k * passo;
      };

  const pA = [0, 0, 0];
  const pB = [0, 0, 0];
  const grad = [0, 0, 0];

  function gradienteEm(i, j, k) {
    if (!posicaoDe) {
      // Grade cartesiana: os três eixos têm a mesma escala, então a diferença
      // central em espaço de índice já é proporcional ao gradiente de mundo.
      grad[0] = em(i + 1, j, k) - em(i - 1, j, k);
      grad[1] = em(i, j + 1, k) - em(i, j - 1, k);
      grad[2] = em(i, j, k + 1) - em(i, j, k - 1);
    } else {
      // -------------------------------------------------------------------
      // GRADE CURVILÍNEA: derivada DIRECIONAL ao longo de cada eixo da grade.
      //
      // Aqui os eixos não têm a mesma escala — um passo radial pode medir 2
      // unidades e um passo angular 30 — nem apontam para direções fixas. Usar
      // a diferença de índice direto daria uma normal enviesada para o eixo de
      // passo menor, e o terreno inteiro pareceria iluminado de lado.
      //
      // A conta certa: para cada eixo, a taxa de variação por unidade de
      // COMPRIMENTO, aplicada na direção real em que aquele eixo anda. Somando
      // as três, reconstrói-se o gradiente. Isso é exato quando os eixos são
      // ortogonais entre si — e numa grade esférica eles são (o radial é
      // perpendicular aos dois angulares).
      // -------------------------------------------------------------------
      grad[0] = grad[1] = grad[2] = 0;
      for (let eixo = 0; eixo < 3; eixo++) {
        const di = eixo === 0 ? 1 : 0;
        const dj = eixo === 1 ? 1 : 0;
        const dk = eixo === 2 ? 1 : 0;

        pos(i + di, j + dj, k + dk, pA);
        pos(i - di, j - dj, k - dk, pB);
        let ex = pA[0] - pB[0], ey = pA[1] - pB[1], ez = pA[2] - pB[2];
        const comprimento = Math.hypot(ex, ey, ez);
        if (comprimento < 1e-12) continue;
        ex /= comprimento; ey /= comprimento; ez /= comprimento;

        const taxa =
          (em(i + di, j + dj, k + dk) - em(i - di, j - dj, k - dk)) / comprimento;
        grad[0] += taxa * ex;
        grad[1] += taxa * ey;
        grad[2] += taxa * ez;
      }
    }

    // A densidade cresce em direção ao AR, então o gradiente já aponta para
    // fora da rocha — que é justamente para onde a normal deve olhar.
    const m = Math.hypot(grad[0], grad[1], grad[2]) || 1;
    grad[0] /= m; grad[1] /= m; grad[2] /= m;
    return grad;
  }

  function vertice(i, j, k, aresta) {
    // Chave pela identidade canônica da aresta na REDE, não pela célula — ver a
    // nota longa em `ARESTA_CANONICA`.
    const [dx, dy, dz, eixo] = ARESTA_CANONICA[aresta];
    const ia = i + dx, ja = j + dy, ka = k + dz;
    const chave = (((ka * ly + ja) * lx + ia) * 3) + eixo;

    const existente = cache.get(chave);
    if (existente !== undefined) return existente;

    const e = EIXO[eixo];
    const ib = ia + e[0], jb = ja + e[1], kb = ka + e[2];

    const va = em(ia, ja, ka);
    const vb = em(ib, jb, kb);

    // Interpolação linear até o zero. A guarda no denominador cobre o caso de
    // dois cantos com o MESMO valor, que só acontece quando ambos são zero —
    // aí qualquer ponto da aresta serve e o meio é a escolha estável.
    const den = vb - va;
    const t = Math.abs(den) < 1e-12 ? 0.5 : -va / den;

    // Interpola entre as POSIÇÕES DE MUNDO dos dois extremos, e não entre os
    // índices de rede. Numa grade cartesiana dá o mesmo; numa curvilínea, não —
    // e interpolar índices colocaria o vértice fora da superfície proporcional-
    // mente à curvatura da célula.
    pos(ia, ja, ka, pA);
    pos(ib, jb, kb, pB);
    const px = pA[0] + (pB[0] - pA[0]) * t;
    const py = pA[1] + (pB[1] - pA[1]) * t;
    const pz = pA[2] + (pB[2] - pA[2]) * t;

    const ga = gradienteEm(ia, ja, ka);
    const g0x = ga[0], g0y = ga[1], g0z = ga[2];
    const gb = gradienteEm(ib, jb, kb);
    // Interpola as normais dos dois cantos com o MESMO peso do vértice: é o que
    // faz a normal acompanhar a posição em vez de saltar de canto em canto.
    let nx = g0x + (gb[0] - g0x) * t;
    let ny = g0y + (gb[1] - g0y) * t;
    let nz = g0z + (gb[2] - g0z) * t;
    const m = Math.hypot(nx, ny, nz) || 1;
    nx /= m; ny /= m; nz /= m;

    const indice = posicoes.length / 3;
    posicoes.push(px, py, pz);
    normais.push(nx, ny, nz);
    cache.set(chave, indice);
    return indice;
  }

  // O laço percorre as CÉLULAS. O deslocamento de 1 é a camada extra da borda:
  // a célula (0,0,0) tem seu canto mínimo na amostra (1,1,1).
  for (let k = 1; k <= nz; k++) {
    for (let j = 1; j <= ny; j++) {
      for (let i = 1; i <= nx; i++) {
        let caso = 0;
        for (let c = 0; c < 8; c++) {
          const d = CANTO[c];
          // Convenção: densidade NEGATIVA é rocha (dentro). O bit liga para o
          // lado de dentro, que é o que as tabelas de Bourke esperam quando o
          // "isolevel" é cruzado de dentro para fora.
          if (em(i + d[0], j + d[1], k + d[2]) < 0) caso |= 1 << c;
        }

        // 0 = tudo fora, 255 = tudo dentro: nenhuma superfície atravessa.
        if (caso === 0 || caso === 255) continue;

        const lista = TRIANGULOS[caso];
        for (let t = 0; t < lista.length; t += 3) {
          // ORDEM INVERTIDA de propósito (t, t+2, t+1).
          //
          // As tabelas de Bourke assumem que o bit liga quando o canto está
          // ACIMA do isolevel; aqui ele liga quando a densidade é NEGATIVA, que
          // é a convenção oposta. Com a ordem original o volume da esfera de
          // teste dava -7208 contra +7238 esperado: a malha inteira olhava para
          // dentro, o que com `side: FrontSide` a deixaria invisível.
          indices.push(
            vertice(i, j, k, lista[t]),
            vertice(i, j, k, lista[t + 2]),
            vertice(i, j, k, lista[t + 1])
          );
        }
      }
    }
  }

  return {
    positions: new Float32Array(posicoes),
    normals: new Float32Array(normais),
    indices: new Uint32Array(indices),
  };
}

export { ARESTAS };
