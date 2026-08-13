/**
 * Definições de vegetação, rochas e depósitos.
 *
 * COMPARTILHADO entre a main thread e o worker: o worker decide ONDE cada
 * prop nasce (precisa dos pesos por bioma) e a main thread decide COMO ele é
 * desenhado. Manter a tabela num só lugar evita o clássico "a densidade
 * mudou mas o visual não".
 *
 * Não importe Three.js aqui.
 */

export const PROP_TYPE = {
  BUSH: 0,
  TREE: 1,
  ROCK: 2,
  DEPOSIT: 3,
};

export const PROP_COUNT = 4;

/**
 * Recursos coletáveis. O índice é o que o worker grava no buffer de props.
 *
 * `cor` tinge o cristal do depósito no mundo 3D. `icone` é o arquivo em
 * `public/icons/` usado pela interface — os dois existem porque uma bolinha
 * colorida não distingue ferrite de cobalto num painel com quatro linhas, e
 * porque cor sozinha exclui quem não a enxerga. `valor` é o preço de venda.
 */
export const RESOURCES = [
  { id: 'ferrite', nome: 'Ferrite', cor: 0x9aa7b4, valor: 8, icone: 'ferrite.svg' },
  { id: 'carbono', nome: 'Carbono', cor: 0x4a5560, valor: 6, icone: 'carbono.svg' },
  { id: 'cobalto', nome: 'Cobalto', cor: 0x4a86ff, valor: 22, icone: 'cobalto.svg' },
  { id: 'fosforo', nome: 'Fósforo', cor: 0xffab35, valor: 34, icone: 'fosforo.svg' },
];

/** Recurso por id, para quem só tem a string. */
export const RESOURCE_BY_ID = new Map(RESOURCES.map((r) => [r.id, r]));

/**
 * Pesos de espalhamento por bioma.
 *
 * Cada valor é a PROBABILIDADE de o candidato virar aquele tipo. A soma fica
 * bem abaixo de 1 de propósito: o resto é chão vazio. Densidade alta demais
 * transforma qualquer planeta em selva e destrói a leitura do relevo.
 */
/**
 * `escalas` é a altura ALVO em unidades de mundo (a geometria é normalizada
 * para altura 1 — ver `AssetLibrary._flatten()`).
 *
 * As árvores subiram de 3,4 para 7,5 numa floresta depois de olhar o resultado:
 * com a altura antiga elas ficavam menores que a nave (4,2 u) e a mata lia como
 * mato rasteiro. Uma árvore precisa ser o dobro da nave para o cérebro aceitar
 * a escala do mundo.
 */
const BASE = {
  Oceano:   { pesos: [0, 0, 0, 0], escalas: [1, 1, 1, 1] },
  Litoral:  { pesos: [0.07, 0.01, 0.05, 0.02], escalas: [0.8, 4.5, 1.1, 1.0] },
  Planície: { pesos: [0.30, 0.06, 0.04, 0.03], escalas: [0.9, 5.8, 1.0, 1.0] },
  Floresta: { pesos: [0.24, 0.34, 0.03, 0.03], escalas: [1.0, 7.5, 1.0, 1.0] },
  Deserto:  { pesos: [0.05, 0.006, 0.11, 0.05], escalas: [0.7, 3.6, 0.85, 1.1] },
  Tundra:   { pesos: [0.11, 0.02, 0.09, 0.04], escalas: [0.7, 4.2, 0.8, 1.0] },
  Rochoso:  { pesos: [0.01, 0.0, 0.23, 0.06], escalas: [0.6, 3.0, 1.15, 1.1] },
  Glacial:  { pesos: [0.02, 0.01, 0.11, 0.04], escalas: [0.6, 3.8, 0.9, 1.0] },
};

const FALLBACK = BASE.Planície;

/**
 * Ajuste por classe do planeta: um mundo árido não deve ter a mesma cobertura
 * vegetal de um temperado, mesmo em bioma equivalente.
 */
const CLASS_MODIFIER = {
  temperado: [1.0, 1.0, 1.0, 1.0],
  árido: [0.35, 0.15, 1.5, 1.4],
  glacial: [0.5, 0.35, 1.2, 1.2],
  exótico: [1.1, 0.8, 1.1, 1.6],
  vulcânico: [0.25, 0.08, 1.7, 1.5],
};

/**
 * @param {string} biome nome devolvido por `sampler.biomeAt()`
 * @param {string} planetType classe do planeta
 * @returns {{ weights: number[], scale: number[] }}
 */
export function biomeScatter(biome, planetType) {
  const base = BASE[biome] ?? FALLBACK;
  const mod = CLASS_MODIFIER[planetType] ?? CLASS_MODIFIER.temperado;

  const weights = new Array(PROP_COUNT);
  for (let i = 0; i < PROP_COUNT; i++) weights[i] = base.pesos[i] * mod[i];

  return { weights, scale: base.escalas };
}

/** O que cada tipo de prop devolve ao ser coletado. */
export const PROP_YIELD = {
  [PROP_TYPE.BUSH]: { recurso: 'carbono', quantidade: [8, 18] },
  [PROP_TYPE.TREE]: { recurso: 'carbono', quantidade: [22, 45] },
  [PROP_TYPE.ROCK]: { recurso: 'ferrite', quantidade: [14, 30] },
  [PROP_TYPE.DEPOSIT]: { recurso: null, quantidade: [40, 90] }, // definido pelo nó
};
