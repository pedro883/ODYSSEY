/**
 * Catálogo de peças construíveis.
 *
 * ---------------------------------------------------------------------------
 * POR QUE O SPACE STATION KIT
 * ---------------------------------------------------------------------------
 * As peças do Kenney Space Station Kit foram desenhadas para encaixar: o piso é
 * exatamente 1×1, a parede tem 1 de largura e 1 de altura, e o pivô de todas
 * está no centro em X/Z com a base em Y=0. Ou seja, a grade já existe dentro dos
 * modelos — o sistema de construção só precisa RESPEITÁ-LA, não inventá-la.
 *
 * Isso tem uma consequência importante: estes modelos NÃO passam pelo
 * `AssetLibrary.getGeometry()`, que normaliza tudo para altura 1. Normalizar um
 * kit modular é destruí-lo — a mesa (0,4 de altura) viraria do tamanho da
 * parede. Aqui a geometria é usada crua, na escala em que o artista exportou, e
 * só o `ESCALA_CELULA` global a leva para as dimensões do jogo.
 *
 * Nem toda peça do pack entrou. Ficaram de fora as que quebram a grade: a mesa
 * grande (1,4 de largura, transborda a célula), a barreira (pivô fora do centro)
 * e as de varanda (0,7 de profundidade, deixariam um vão de 0,3 em cada célula).
 * Um kit modular só é modular dentro do módulo.
 *
 * ---------------------------------------------------------------------------
 * TRÊS ENCAIXES
 * ---------------------------------------------------------------------------
 *   `celula`  — o PISO de um quadrado da grade (piso, piso técnico, rampa).
 *   `mobilia` — o que fica EM CIMA desse piso (mesa, contêiner, terminal).
 *   `borda`   — a FRONTEIRA entre dois quadrados (parede, porta, guarda-corpo).
 *               Cabem quatro por célula, uma por lado.
 *
 * Sem essa separação, ou as paredes ficariam no meio do cômodo, ou cada parede
 * consumiria uma célula inteira de piso.
 *
 * `mobilia` é uma camada à parte de `celula` e não um detalhe: as duas ocupam o
 * mesmo quadrado, e tratá-las como o mesmo encaixe faria colocar uma mesa
 * EXIGIR arrancar o piso debaixo dela. A mobília também sobe automaticamente a
 * espessura da laje, senão a mesa nasce meio enterrada no próprio chão.
 */

/**
 * Quantas unidades de mundo vale uma célula da grade.
 *
 * O kit é 1×1 e a parede tem 1 de altura. O jogador tem 1,7 de altura de olho
 * (ver `PlayerController`), então uma parede de 1 unidade bateria no joelho.
 * Três põe o teto a 3 unidades e o piso em 3×3 — um cômodo em que um humano de
 * 1,8 m circula sem se sentir dentro de uma casa de bonecas.
 */
export const ESCALA_CELULA = 3;

/**
 * Categorias, na ordem em que aparecem no painel.
 *
 * Servem para navegação, não para regra: nada no sistema depende da categoria
 * de uma peça. Existem porque 27 peças numa lista única é um catálogo que
 * ninguém lê até o fim — e a primeira coisa que o jogador procura ("como fecho
 * esta parede?") é justamente um agrupamento.
 */
export const CATEGORIAS = [
  { id: 'estrutura', nome: 'Estrutura', resumo: 'Pisos e circulação vertical' },
  { id: 'vedacao', nome: 'Vedação', resumo: 'Paredes, portas e janelas' },
  { id: 'protecao', nome: 'Proteção', resumo: 'Guarda-corpos de borda aberta' },
  { id: 'mobilia', nome: 'Mobília', resumo: 'Armazenamento e descanso' },
  { id: 'tecnologia', nome: 'Tecnologia', resumo: 'Terminais, telas e energia' },
  { id: 'utilidade', nome: 'Utilidade', resumo: 'Dutos e acabamento' },
];

/**
 * Custo em recursos. Os ids vêm de `shared/props.js`.
 *
 * A tabela é deliberadamente barata: numa PoC, o prazer é ver a base subir, não
 * moer arbusto por duas horas antes da primeira parede. Uma sessão de mineração
 * de ~5 minutos já paga um cômodo fechado. O que a tabela SIM comunica é
 * hierarquia — ferrite é estrutura, carbono é conforto, cobalto é eletrônica e
 * fósforo só aparece no que produz ou exibe energia.
 */
export const PECAS = [
  /* --- Estrutura --------------------------------------------------------- */
  {
    id: 'piso',
    nome: 'Piso',
    categoria: 'estrutura',
    modelo: 'base/floor.glb',
    encaixe: 'celula',
    custo: { ferrite: 15 },
    // Piso não bloqueia: o jogador anda EM CIMA dele. Ver `BuildSystem._empurrar`.
    solido: false,
    apoio: true,
  },
  {
    id: 'piso-tecnico',
    nome: 'Piso técnico',
    categoria: 'estrutura',
    modelo: 'base/floor-detail.glb',
    encaixe: 'celula',
    custo: { ferrite: 20, carbono: 10 },
    solido: false,
    apoio: true,
  },
  {
    id: 'piso-painel',
    nome: 'Piso iluminado',
    categoria: 'estrutura',
    modelo: 'base/floor-panel.glb',
    encaixe: 'celula',
    custo: { ferrite: 18, cobalto: 5 },
    solido: false,
    apoio: true,
  },
  {
    id: 'rampa',
    nome: 'Rampa',
    categoria: 'estrutura',
    modelo: 'base/stairs-ramp.glb',
    encaixe: 'celula',
    custo: { ferrite: 30 },
    solido: false,
    apoio: true,
  },
  {
    id: 'escada',
    nome: 'Escada',
    categoria: 'estrutura',
    modelo: 'base/stairs.glb',
    encaixe: 'celula',
    custo: { ferrite: 30 },
    solido: false,
    apoio: true,
  },

  /* --- Vedação ----------------------------------------------------------- */
  {
    id: 'parede',
    nome: 'Parede',
    categoria: 'vedacao',
    modelo: 'base/wall.glb',
    encaixe: 'borda',
    custo: { ferrite: 25 },
    solido: true,
  },
  {
    id: 'parede-canto',
    nome: 'Canto',
    categoria: 'vedacao',
    modelo: 'base/wall-corner.glb',
    encaixe: 'borda',
    custo: { ferrite: 20 },
    solido: true,
  },
  {
    id: 'canto-curvo',
    nome: 'Canto curvo',
    categoria: 'vedacao',
    modelo: 'base/wall-corner-round.glb',
    encaixe: 'borda',
    custo: { ferrite: 22 },
    solido: true,
  },
  {
    id: 'porta',
    nome: 'Porta',
    categoria: 'vedacao',
    modelo: 'base/wall-door.glb',
    encaixe: 'borda',
    custo: { ferrite: 30, cobalto: 5 },
    // A porta é um vão: bloquear seria transformar a entrada em parede pintada.
    solido: false,
  },
  {
    id: 'portao',
    nome: 'Portão',
    categoria: 'vedacao',
    modelo: 'base/wall-door-wide.glb',
    encaixe: 'borda',
    custo: { ferrite: 40, cobalto: 8 },
    solido: false,
  },
  {
    id: 'janela',
    nome: 'Janela',
    categoria: 'vedacao',
    modelo: 'base/wall-window.glb',
    encaixe: 'borda',
    custo: { ferrite: 25, cobalto: 10 },
    solido: true,
  },
  {
    id: 'pilar',
    nome: 'Pilar',
    categoria: 'vedacao',
    modelo: 'base/wall-pillar.glb',
    encaixe: 'borda',
    custo: { ferrite: 20 },
    solido: true,
  },

  /* --- Proteção ---------------------------------------------------------- */
  {
    id: 'guarda-corpo',
    nome: 'Guarda-corpo',
    categoria: 'protecao',
    modelo: 'base/rail.glb',
    encaixe: 'borda',
    custo: { ferrite: 10 },
    solido: true,
  },
  {
    id: 'guarda-corpo-curto',
    nome: 'Meia-grade',
    categoria: 'protecao',
    modelo: 'base/rail-narrow.glb',
    encaixe: 'borda',
    custo: { ferrite: 6 },
    solido: true,
  },

  /* --- Mobília ----------------------------------------------------------- */
  {
    id: 'container',
    nome: 'Contêiner',
    categoria: 'mobilia',
    modelo: 'base/container.glb',
    encaixe: 'mobilia',
    custo: { ferrite: 20, carbono: 15 },
    solido: true,
  },
  {
    id: 'container-alto',
    nome: 'Contêiner alto',
    categoria: 'mobilia',
    modelo: 'base/container-tall.glb',
    encaixe: 'mobilia',
    custo: { ferrite: 30, carbono: 20 },
    solido: true,
  },
  {
    id: 'container-baixo',
    nome: 'Caixa de carga',
    categoria: 'mobilia',
    modelo: 'base/container-flat.glb',
    encaixe: 'mobilia',
    custo: { ferrite: 22, carbono: 12 },
    solido: true,
  },
  {
    id: 'mesa',
    nome: 'Mesa',
    categoria: 'mobilia',
    modelo: 'base/table.glb',
    encaixe: 'mobilia',
    custo: { carbono: 15 },
    solido: true,
  },
  {
    id: 'cadeira',
    nome: 'Cadeira',
    categoria: 'mobilia',
    modelo: 'base/chair.glb',
    encaixe: 'mobilia',
    custo: { carbono: 8 },
    solido: true,
  },
  {
    id: 'leito',
    nome: 'Leito',
    categoria: 'mobilia',
    modelo: 'base/bed-single.glb',
    encaixe: 'mobilia',
    custo: { carbono: 20 },
    solido: true,
  },

  /* --- Tecnologia -------------------------------------------------------- */
  {
    id: 'terminal',
    nome: 'Terminal',
    categoria: 'tecnologia',
    modelo: 'base/computer.glb',
    encaixe: 'mobilia',
    custo: { ferrite: 15, cobalto: 20 },
    solido: true,
  },
  {
    id: 'console',
    nome: 'Console',
    categoria: 'tecnologia',
    modelo: 'base/computer-wide.glb',
    encaixe: 'mobilia',
    custo: { ferrite: 20, cobalto: 26 },
    solido: true,
  },
  {
    id: 'holomesa',
    nome: 'Holomesa',
    categoria: 'tecnologia',
    modelo: 'base/table-display-planet.glb',
    encaixe: 'mobilia',
    custo: { cobalto: 30, fosforo: 20 },
    solido: true,
  },
  {
    id: 'monitor',
    nome: 'Monitor',
    categoria: 'tecnologia',
    modelo: 'base/display-wall.glb',
    encaixe: 'mobilia',
    custo: { ferrite: 10, cobalto: 14 },
    solido: true,
  },
  {
    id: 'painel-solar',
    nome: 'Painel solar',
    categoria: 'tecnologia',
    modelo: 'base/structure-panel.glb',
    encaixe: 'mobilia',
    custo: { ferrite: 25, fosforo: 15 },
    solido: false,
  },

  /* --- Utilidade --------------------------------------------------------- */
  {
    id: 'duto',
    nome: 'Duto',
    categoria: 'utilidade',
    modelo: 'base/pipe.glb',
    encaixe: 'mobilia',
    custo: { ferrite: 8 },
    solido: false,
  },
  {
    id: 'duto-curva',
    nome: 'Duto em curva',
    categoria: 'utilidade',
    modelo: 'base/pipe-bend.glb',
    encaixe: 'mobilia',
    custo: { ferrite: 10 },
    solido: false,
  },
];

/** @type {Map<string, typeof PECAS[number]>} */
export const PECA_POR_ID = new Map(PECAS.map((p) => [p.id, p]));

/** Peças de uma categoria, na ordem do catálogo. */
export function pecasDaCategoria(categoria) {
  return PECAS.filter((p) => p.categoria === categoria);
}

/** Tudo que o boot precisa baixar para a construção funcionar. */
export function caminhosDePecas() {
  return PECAS.map((p) => p.modelo);
}

/** Custo formatado para texto corrido ("15 Ferrite · 5 Cobalto"). */
export function descreverCusto(peca, nomeDoRecurso) {
  return Object.entries(peca.custo)
    .map(([id, qtd]) => `${qtd} ${nomeDoRecurso(id)}`)
    .join(' · ');
}
