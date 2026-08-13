/**
 * Árvores procedurais com EZ-Tree (https://www.eztree.dev/).
 *
 * ---------------------------------------------------------------------------
 * POR QUE TROCAR OS .glb DO KENNEY POR GERAÇÃO PROCEDURAL
 * ---------------------------------------------------------------------------
 * O pack tinha 3 árvores por classe de planeta, todas pintadas com UMA cor de
 * material — `palette.grass * 1.35`. Resultado: tronco verde, copa verde, e o
 * mesmo verde em todos os mundos. Nenhuma quantidade de variação de brilho por
 * instância conserta isso, porque o problema não é o tom, é a falta de partes:
 * uma árvore de verdade tem casca e folha, e são coisas de cores diferentes.
 *
 * O EZ-Tree gera a copa e o tronco como DUAS malhas separadas, com texturas de
 * casca e de folha próprias. Isso resolve o problema na raiz e ainda cabe na
 * premissa do projeto: a árvore não é um arquivo, é uma função do seed — o
 * mesmo contrato do terreno, da paleta e da atmosfera.
 *
 * ---------------------------------------------------------------------------
 * ORÇAMENTO DE TRIÂNGULOS
 * ---------------------------------------------------------------------------
 * Instancing não perdoa geometria pesada: 1200 árvores de 3000 triângulos são
 * 3,6 milhões de triângulos por frame só de vegetação. Os perfis abaixo baixam
 * `levels`, `sections` e `segments` dos presets originais e usam billboard
 * simples nas folhas, mirando ~600–900 triângulos por árvore. É o suficiente
 * para a silhueta ler como árvore à distância que o jogador realmente vê — a
 * pé, nunca há mais do que algumas dezenas dentro de 50 unidades.
 *
 * ---------------------------------------------------------------------------
 * CACHE
 * ---------------------------------------------------------------------------
 * A geometria é cacheada por (perfil, seed) e COMPARTILHADA entre planetas: um
 * carvalho é o mesmo carvalho em qualquer mundo, o que muda é o material (cor
 * da folhagem daquele planeta). Sem o cache, cada `PropScatter` regeneraria as
 * mesmas 3 árvores — e a geração custa alguns milissegundos de main thread.
 */

import * as THREE from 'three';
import { Tree, TreePreset } from '@dgreenheck/ez-tree';

const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();

/**
 * Perfis por classe de planeta.
 *
 * `preset` é o ponto de partida do EZ-Tree; `tune` é o corte de detalhe e a
 * personalidade de cada mundo. Três variantes por classe, o mesmo teto que o
 * manifesto de modelos já usava (cada variante é uma dupla de InstancedMesh).
 */
const PROFILES = {
  temperado: [
    { preset: 'Oak Medium', bark: 'oak', leaf: 'oak' },
    { preset: 'Ash Medium', bark: 'birch', leaf: 'ash' },
    { preset: 'Aspen Medium', bark: 'birch', leaf: 'aspen' },
  ],
  glacial: [
    { preset: 'Pine Medium', bark: 'pine', leaf: 'pine' },
    { preset: 'Pine Large', bark: 'pine', leaf: 'pine' },
    { preset: 'Aspen Small', bark: 'birch', leaf: 'aspen' },
  ],
  // Mundo árido: troncos finos e copa rala. O `leaves.count` baixo é o que
  // faz a árvore parecer sedenta em vez de apenas menor.
  árido: [
    { preset: 'Ash Small', bark: 'willow', leaf: 'ash', tune: { leaves: { count: 1, size: 1.6 } } },
    { preset: 'Oak Small', bark: 'oak', leaf: 'ash', tune: { leaves: { count: 1, size: 1.4 } } },
  ],
  // Sem entrada para `exótico`: lá o manifesto declara cogumelos gigantes, e o
  // `PropScatter` nem chega a pedir árvore procedural.
  // Vulcânico: só troncos calcinados. Copa mínima, porque a graça do bioma é
  // a silhueta seca contra o céu.
  vulcânico: [
    { preset: 'Oak Small', bark: 'oak', leaf: 'ash', tune: { leaves: { count: 1, size: 1.1 } } },
  ],
};

const FALLBACK_PROFILES = PROFILES.temperado;

/**
 * Corte de detalhe aplicado a TODOS os perfis, por cima do preset.
 *
 * ---------------------------------------------------------------------------
 * ONDE CORTAR: SEÇÕES E SEGMENTOS, NUNCA NÍVEIS
 * ---------------------------------------------------------------------------
 * A primeira versão disto limitava `branch.levels` a 2, e o resultado foi uma
 * floresta de árvores MORTAS: só troncos e galhos nus. O motivo é que a
 * folhagem nasce nos galhos do ÚLTIMO nível — cortar o nível 3 não desbasta a
 * copa, ele apaga a copa.
 *
 * Seções (ao longo do galho) e segmentos (ao redor dele) é que multiplicam
 * triângulos, e reduzi-los não muda a silhueta: um galho fino com 3 lados só
 * se denuncia com a câmera encostada nele. É de lá que sai a economia.
 */
function budgetTune(options) {
  // Os três níveis ficam. O nível 3 é barato (galhos curtos e finos) e é ele
  // que segura as folhas.
  options.branch.levels = Math.min(options.branch.levels, 3);
  options.branch.sections = { 0: 5, 1: 4, 2: 3, 3: 2 };
  options.branch.segments = { 0: 5, 1: 4, 2: 3, 3: 3 };
  // O número de galhos é o que multiplica TUDO: cada galho do último nível
  // carrega seções, segmentos e folhas. Medido no perfil "Oak Medium": com
  // 6/4/3 filhos a árvore vai a 8 364 triângulos; com 5/3/2 ela cai para
  // ~2 500 e continua parecendo uma árvore.
  options.branch.children = {
    0: Math.min(options.branch.children[0] ?? 6, 5),
    1: Math.min(options.branch.children[1] ?? 5, 3),
    2: Math.min(options.branch.children[2] ?? 3, 2),
  };

  // Folha maior que o preset, porém não mais numerosa. O preset foi feito para
  // uma árvore isolada vista de perto no editor do EZ-Tree; aqui ela é uma
  // entre centenas, a dezenas de unidades, e o que precisa ler é a MASSA da
  // copa — que sai mais barato aumentando o tamanho do que a contagem.
  options.leaves.count = Math.max(options.leaves.count ?? 1, 2);
  options.leaves.size = (options.leaves.size ?? 2.5) * 2.1;
  // Billboard simples: metade dos triângulos de folha. O par cruzado só se
  // justifica quando a câmera circula a árvore de perto, o que aqui não
  // acontece — a pé o jogador passa por elas, não em volta delas.
  options.leaves.billboard = 'single';
  options.trellis.enabled = false;
  return options;
}

/** @type {Map<string, {bark: THREE.BufferGeometry, leaves: THREE.BufferGeometry, barkMap: THREE.Texture|null, leafMap: THREE.Texture|null, triangles: number}>} */
const cache = new Map();

/**
 * Normais das folhas apontando para FORA do volume da copa.
 *
 * As normais que o `computeVertexNormals()` produz são as do quad do
 * billboard: cada folha fica com uma normal só, e a copa inteira acende e
 * apaga em blocos conforme o sol gira — parece uma pilha de cartas, não uma
 * massa de folhagem. Substituindo pela direção do centro da copa até o
 * vértice, a iluminação vira a de uma esfera macia, que é como uma copa real
 * se comporta a qualquer distância maior que um galho.
 */
function softenLeafNormals(geometry) {
  const position = geometry.attributes.position;
  const normal = new Float32Array(position.count * 3);

  geometry.computeBoundingBox();
  geometry.boundingBox.getCenter(_center);

  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i).sub(_center);
    if (v.lengthSq() < 1e-6) v.set(0, 1, 0);
    v.normalize();
    // Um viés para cima: a luz do céu chega de cima mesmo nas folhas de baixo.
    v.y += 0.35;
    v.normalize();
    normal[i * 3] = v.x;
    normal[i * 3 + 1] = v.y;
    normal[i * 3 + 2] = v.z;
  }

  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
}

/**
 * Gera (ou recupera do cache) as duas geometrias de uma árvore.
 *
 * A normalização é a MESMA convenção do `AssetLibrary`: base em y=0, centrada
 * em X/Z, altura exatamente 1 — e aplicada com o MESMO fator às duas partes,
 * senão a copa desgruda do tronco.
 *
 * @param {{preset: string, bark: string, leaf: string, tune?: object}} profile
 * @param {number} seed
 */
function buildTree(profile, seed) {
  const key = `${profile.preset}|${seed}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const tree = new Tree();
  // `tree.loadPreset()` seria o caminho óbvio, mas ele chama `generate()` no
  // fim — e nós ainda vamos mexer nas opções, o que forçaria uma SEGUNDA
  // geração. Copiar o preset direto nas opções gera a árvore uma vez só.
  tree.options.copy(TreePreset[profile.preset]);
  tree.options.seed = seed;
  tree.options.bark.type = profile.bark;
  tree.options.leaves.type = profile.leaf;
  // Tinta neutra nos dois: a cor do planeta entra pelo material do jogo, não
  // aqui. Tingir duas vezes multiplicaria as cores e escureceria tudo.
  tree.options.bark.tint = 0xffffff;
  tree.options.leaves.tint = 0xffffff;
  if (profile.tune) tree.options.copy(profile.tune);
  budgetTune(tree.options);

  tree.generate();

  const bark = tree.branchesMesh.geometry.clone();
  const leaves = tree.leavesMesh.geometry.clone();
  const triangles = tree.triangleCount;

  // As texturas SOBREVIVEM ao descarte da árvore: são compartilhadas por todas
  // as instâncias e por todos os planetas (o EZ-Tree já as cacheia por tipo).
  const barkMap = tree.branchesMesh.material.map ?? null;
  const leafMap = tree.leavesMesh.material.map ?? null;
  if (leafMap) {
    // O EZ-Tree sobe as folhas com alfa PRÉ-MULTIPLICADO, o que faz sentido
    // para o material transparente dele. Aqui elas são desenhadas com
    // `alphaTest` (opacas, sem blending), e o RGB pré-multiplicado deixaria um
    // halo escuro na borda de cada folha. Ainda dá tempo de corrigir: a
    // textura só sobe para a GPU no primeiro frame que a usa.
    leafMap.premultiplyAlpha = false;
    leafMap.needsUpdate = true;
  }

  // Uma normalização para as duas partes, derivada da união dos limites.
  bark.computeBoundingBox();
  leaves.computeBoundingBox();
  _box.copy(bark.boundingBox).union(leaves.boundingBox);
  _box.getSize(_size);
  _box.getCenter(_center);

  const height = _size.y || 1;
  const inv = 1 / height;
  for (const geometry of [bark, leaves]) {
    geometry.translate(-_center.x, -_box.min.y, -_center.z);
    geometry.scale(inv, inv, inv);
  }

  softenLeafNormals(leaves);
  bark.computeBoundingSphere();
  leaves.computeBoundingSphere();

  // A árvore em si (grupo, malhas e materiais do EZ-Tree) não entra na cena:
  // só queríamos os buffers. Sem este descarte, cada geração vazaria dois
  // materiais e duas geometrias na GPU.
  tree.branchesMesh.geometry.dispose();
  tree.leavesMesh.geometry.dispose();
  tree.branchesMesh.material.dispose();
  tree.leavesMesh.material.dispose();

  const entry = { bark, leaves, barkMap, leafMap, triangles };
  cache.set(key, entry);
  return entry;
}

/**
 * Variantes de árvore de uma classe de planeta.
 *
 * @param {string} planetType
 * @param {number} seed do planeta — dois mundos temperados não têm a MESMA
 *   floresta, ainda que ambos usem o perfil "carvalho"
 */
export function treeVariantsFor(planetType, seed) {
  const profiles = PROFILES[planetType] ?? FALLBACK_PROFILES;
  return profiles.map((profile, index) =>
    // O seed é quantizado: sem isso cada planeta geraria árvores novas e o
    // cache nunca acertaria. Com 8 famílias por perfil já não se percebe
    // repetição entre mundos, e a geração acontece no máximo 8 vezes.
    buildTree(profile, ((seed >>> (index * 3)) % 8) + index * 101)
  );
}

/** Triângulos por árvore de cada variante — só para diagnóstico no boot. */
export function treeTriangleBudget() {
  return [...cache.entries()].map(([key, entry]) => `${key}: ${entry.triangles}`);
}
