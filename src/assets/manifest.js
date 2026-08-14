/**
 * Quais modelos cada coisa usa.
 *
 * Tudo que é "arte" fica declarado aqui, e só aqui. Trocar a nave, adicionar
 * uma espécie de fauna ou dar cactos a mais um tipo de planeta é editar este
 * arquivo — nenhum sistema precisa saber nomes de arquivo.
 *
 * ---------------------------------------------------------------------------
 * POR QUE POR CLASSE DE PLANETA E NÃO POR BIOMA
 * ---------------------------------------------------------------------------
 * Seria melhor variar por bioma (deserto ganha cacto, floresta ganha árvore).
 * Mas o bioma é calculado DENTRO do worker, por prop, e não chega ao
 * `PropScatter` — o buffer só carrega tipo, escala, giro e matiz. Mandar o
 * bioma junto exigiria mudar o protocolo e o stride do worker.
 *
 * A classe do planeta (árido, glacial, exótico...) já está disponível na main
 * thread e produz quase a mesma variedade percebida: um mundo árido inteiro
 * com cactos e pedras de areia lê como deserto. Fica registrado como o próximo
 * refinamento óbvio, se um dia valer o custo.
 */

import { PROP_TYPE } from '../shared/props.js';

/**
 * Modelos por classe de planeta, indexados por PROP_TYPE.
 *
 * Máximo de 4 variantes por tipo: cada variante é um `InstancedMesh`, e
 * 4 tipos × 4 variantes = 16 draw calls, um acréscimo desprezível frente aos
 * ~125 atuais. Passar disso deixaria de ser desprezível.
 */
/**
 * ---------------------------------------------------------------------------
 * LINHA DE ÁRVORE VAZIA = ÁRVORE PROCEDURAL
 * ---------------------------------------------------------------------------
 * Quando a linha de `PROP_TYPE.TREE` está vazia, o `PropScatter` gera as
 * árvores com o EZ-Tree a partir do seed do planeta (ver
 * `assets/TreeFactory.js`) — tronco e copa como partes separadas, que é o que
 * finalmente permite ter casca marrom e folha colorida no mesmo objeto.
 *
 * A exceção é o mundo exótico: lá os "troncos" são cogumelos gigantes do
 * Kenney, e nenhuma árvore procedural entrega a mesma estranheza. Vale mais a
 * arte dedicada. Os .glb de árvore comum continuam no repositório, mas fora
 * desta lista eles nem são baixados no boot.
 */
const TEMPERADO = [
  ['flora/plant_bush.glb', 'flora/plant_bushDetailed.glb', 'flora/grass_large.glb', 'flora/flower_redA.glb'],
  [],
  ['rocha/rock_largeA.glb', 'rocha/rock_largeB.glb', 'rocha/rock_largeC.glb'],
  ['deposito/rock_crystals.glb', 'deposito/rock_crystalsLargeA.glb'],
];

export const PROP_MODELS = {
  temperado: TEMPERADO,

  árido: [
    ['flora/cactus_short.glb', 'flora/plant_bushSmall.glb', 'flora/grass_leafsLarge.glb'],
    [],
    ['rocha/rock-sand-a.glb', 'rocha/rock-sand-b.glb', 'rocha/rock-sand-c.glb'],
    ['deposito/rock_crystalsLargeA.glb', 'deposito/rock_crystalsLargeB.glb'],
  ],

  glacial: [
    ['flora/plant_bushSmall.glb', 'flora/grass_large.glb'],
    [],
    ['rocha/rock_largeA.glb', 'rocha/rock_largeC.glb'],
    ['deposito/rock_crystals.glb', 'deposito/rock_crystalsLargeB.glb'],
  ],

  // Mundos exóticos ganham a paleta de cogumelos e flores: é o que os faz
  // parecer "errados" no bom sentido, sem precisar de arte dedicada.
  exótico: [
    ['flora/mushroom_red.glb', 'flora/flower_purpleA.glb', 'flora/flower_yellowA.glb', 'flora/plant_bushDetailed.glb'],
    ['flora/mushroom_redTall.glb', 'flora/mushroom_tanTall.glb'],
    ['rocha/rock_largeB.glb', 'rocha/rock_largeC.glb'],
    ['deposito/rock_crystalsLargeA.glb', 'deposito/rock_crystals.glb'],
  ],

  vulcânico: [
    ['flora/plant_bushSmall.glb'],
    [],
    ['rocha/rock-sand-a.glb', 'rocha/rock_largeA.glb', 'rocha/rock-sand-c.glb'],
    ['deposito/rock_crystalsLargeB.glb', 'deposito/rock_crystals.glb'],
  ],
};

/** Usado quando a classe do planeta não estiver no mapa acima. */
export const PROP_MODELS_FALLBACK = TEMPERADO;

/** @param {string} planetType */
export function propModelsFor(planetType) {
  return PROP_MODELS[planetType] ?? PROP_MODELS_FALLBACK;
}

/* ========================================================================== */
/* Nave                                                                       */
/* ========================================================================== */

export const SHIP_MODEL = {
  path: 'nave/craft_speederA.glb',
  /** Altura alvo em unidades de mundo (o AssetLibrary normaliza para 1). */
  size: 4.2,
  /**
   * Correção de orientação, em radianos no eixo Y.
   *
   * A nave do jogo (e a câmera do Three) apontam para -Z, e
   * `ShipController._getForward()` depende disso. A correção fica AQUI, na
   * importação do asset, e não no controlador: assim trocar de modelo nunca
   * vira uma caça ao bug na física de voo.
   *
   * ZERO, e não `Math.PI`: o `craft_speederA` já nasce apontando para -Z. O
   * meio-giro que estava aqui vinha da suposição de que todo modelo do Kenney
   * Space Kit aponta para +Z, e o efeito era a nave voar de ré — nariz virado
   * para a câmera de perseguição, que vive atrás dela.
   *
   * Se um dia entrar um modelo que de fato aponte para +Z, o conserto é este
   * campo (`Math.PI`), nunca o controlador.
   */
  yaw: 0,
};

/* ========================================================================== */
/* Fauna                                                                      */
/* ========================================================================== */

/**
 * Espécies disponíveis. Os Cube Pets já vêm com os clipes `idle`, `walk`,
 * `run` e `eat` — exatamente os estados da máquina em `world/Fauna.js`.
 *
 * `altura` é o tamanho alvo em unidades (o modelo é normalizado para 1), e
 * `velocidade` multiplica a velocidade base de caminhada. Juntos, dão a cada
 * espécie um peso perceptível: um elefante é lento e enorme, uma abelha é
 * rápida e minúscula.
 */
export const FAUNA_SPECIES = [
  { path: 'fauna/animal-crab.glb',        altura: 0.7, velocidade: 0.7, nome: 'rastejante' },
  { path: 'fauna/animal-caterpillar.glb', altura: 0.6, velocidade: 0.5, nome: 'larval' },
  // `voa` faz a criatura pairar acima do solo em vez de colar nele.
  { path: 'fauna/animal-parrot.glb',      altura: 0.9, velocidade: 1.3, nome: 'alado', voa: true },
  // ---------------------------------------------------------------------------
  // `agressivo` e `noturno` (ver `Fauna.js`)
  //
  // `agressivo`: detecta o jogador de longe, persegue e ataca ao encostar. Só
  // TRÊS espécies de dez, e é de propósito — se a maioria caçasse, andar a pé
  // viraria combate contínuo e a exploração, que é o miolo do jogo, sumiria.
  //
  // `noturno`: só nasce com o sol abaixo do horizonte. Dá ao ciclo dia/noite uma
  // consequência de jogo, e não apenas de iluminação.
  // ---------------------------------------------------------------------------
  { path: 'fauna/animal-bee.glb',         altura: 0.5, velocidade: 1.6, nome: 'enxame', voa: true, agressivo: true, dano: 4, cadencia: 0.7 },
  { path: 'fauna/animal-deer.glb',        altura: 1.9, velocidade: 1.2, nome: 'herbívoro' },
  { path: 'fauna/animal-fox.glb',         altura: 1.1, velocidade: 1.4, nome: 'predador', agressivo: true, dano: 11, cadencia: 1.1 },
  { path: 'fauna/animal-penguin.glb',     altura: 1.2, velocidade: 0.8, nome: 'bípede' },
  { path: 'fauna/animal-elephant.glb',    altura: 3.2, velocidade: 0.6, nome: 'colossal' },
  { path: 'fauna/animal-giraffe.glb',     altura: 4.0, velocidade: 0.9, nome: 'longilíneo' },
  { path: 'fauna/animal-koala.glb',       altura: 1.0, velocidade: 0.7, nome: 'arborícola' },
  { path: 'fauna/animal-crab.glb',        altura: 1.4, velocidade: 1.1, nome: 'noturno', agressivo: true, noturno: true, dano: 15, cadencia: 1.3 },
];

/**
 * Só os props. Estes precisam ser ACHATADOS numa geometria única (instancing);
 * a nave e a fauna não — a nave é um objeto só e a fauna precisa da hierarquia
 * de nós intacta, senão a animação não tem o que mover.
 */
export function propPaths() {
  const paths = new Set();
  for (const porTipo of Object.values(PROP_MODELS)) {
    for (const variantes of porTipo) for (const p of variantes) paths.add(p);
  }
  return [...paths];
}

/** Tudo que o boot precisa ter em mãos antes de liberar o jogo. */
export function allPreloadPaths() {
  const paths = new Set(propPaths());
  paths.add(SHIP_MODEL.path);
  for (const s of FAUNA_SPECIES) paths.add(s.path);
  return [...paths];
}

export { PROP_TYPE };
