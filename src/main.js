/**
 * Ponto de entrada: monta o sistema estelar e roda o loop.
 *
 * ORDEM DE ATUALIZAÇÃO POR FRAME (importa!)
 *   1. fundo estelar   -> define a direção do sol deste frame
 *   2. planeta ativo   -> o corpo mais próximo governa gravidade e atmosfera
 *   3. física          -> nave OU jogador a pé
 *   4. estado do jogo  -> lê a nova altitude e ajusta névoa/luz/exposição
 *   5. câmera          -> posição final deste frame
 *   6. LOD dos planetas-> subdivide em torno da câmera JÁ atualizada
 *   7. ferramentas + HUD
 *
 * Atualizar o LOD antes de mover a câmera custa um frame de atraso na
 * subdivisão — visível como terreno que "engrossa" tarde ao mergulhar.
 */

import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { GameState, Phase } from './core/GameState.js';
import { StarSystem } from './world/StarSystem.js';
import { createShip } from './entities/Ship.js';
import { WarpLines } from './entities/WarpLines.js';
import { ShipController } from './controls/ShipController.js';
import { PlayerController } from './controls/PlayerController.js';
import { Inventory } from './game/Inventory.js';
import { Discovery } from './game/Discovery.js';
import { Scanner } from './game/Scanner.js';
import { BuildSystem } from './game/BuildSystem.js';
import { Terraform } from './game/Terraform.js';
import { FERRAMENTAS, caminhosDeFerramentas } from './game/Tools.js';
import { ViewModel } from './entities/ViewModel.js';
import { GalaxyMap } from './galaxy/GalaxyMap.js';
import { WarpJump } from './galaxy/WarpJump.js';
import { GALAXIAS, nomeDoSistema } from './shared/galaxy.js';
import { PECAS, descreverCusto } from './assets/buildings.js';
import { RESOURCES } from './shared/props.js';
import { HUD, toLatLon } from './ui/HUD.js';
import { assets } from './assets/AssetLibrary.js';
import { allPreloadPaths, propPaths } from './assets/manifest.js';
import { windTime } from './shaders/WindShader.js';
import { cloudQuality } from './world/Clouds.js';
import { audio } from './audio/AudioEngine.js';
import { FloatingOrigin } from './core/FloatingOrigin.js';
import { Multiplayer } from './net/Multiplayer.js';
import { Weather, CLIMAS } from './world/Weather.js';
import { SombrasDoSol } from './world/Sombras.js';
import { CeuAmbiente } from './world/CeuAmbiente.js';
import { Vitais } from './game/Vitals.js';
import { Projeteis } from './game/Weapons.js';
import { Blaster } from './game/Blaster.js';
import { EDICAO } from './shared/edits.js';
import { Sentinelas } from './game/Sentinelas.js';
import { Qualidade } from './game/Qualidade.js';
import { MenuPausa } from './ui/MenuPausa.js';

/* ========================================================================== */
/* Seed                                                                       */
/* ========================================================================== */

// `?seed=12345` na URL reproduz exatamente o mesmo sistema estelar. Todo o
// universo desta PoC cabe nesse inteiro — é o que torna "infinito" viável.
const params = new URLSearchParams(location.search);
/**
 * O jogador ESCOLHEU este sistema?
 *
 * Com a sala dividida em canais por sistema, seeds diferentes deixaram de ser
 * um conflito e passaram a ser lugares diferentes da galáxia. Quem abre o jogo
 * sem escolher nada continua caindo junto de quem já está na sala (é o que faz
 * "entrar com um amigo" funcionar sem combinar número nenhum); quem chega com
 * `?seed=` quer aquele sistema, e o servidor respeita. Ver `_alinharSeed`.
 */
const SEED_EXPLICITO = params.has('seed');
const SEED = SEED_EXPLICITO
  ? Number(params.get('seed')) >>> 0
  : (Math.random() * 0xffffffff) >>> 0;

/* ========================================================================== */
/* DOM                                                                        */
/* ========================================================================== */

const canvas = document.getElementById('viewport');
const overlay = document.getElementById('overlay');
const startButton = document.getElementById('start-btn');
const bootStatus = document.getElementById('boot-status');
const pilotForm = document.getElementById('pilot-form');
const pilotInput = document.getElementById('pilot-name');
const pilotHint = document.getElementById('pilot-hint');
const pilotPass = document.getElementById('pilot-pass');

/** Há conta autenticada? Só então faz sentido salvar progresso. */
let contaAtiva = false;

/* ========================================================================== */
/* Nome do piloto                                                             */
/* ========================================================================== */

/**
 * Identidade do jogador.
 *
 * Hoje mora no `localStorage` e serve para o multijogador saber como te chamar.
 * É deliberadamente um NOME, não uma conta: não há senha, não há servidor de
 * identidade e nada impede duas pessoas de usarem o mesmo. Quando entrar o
 * MySQL (ver as anotações do projeto), este campo vira o login de verdade e o
 * `localStorage` passa a guardar sessão, não identidade.
 */
const NOME_GUARDADO = 'nms.piloto';
const NOME_VALIDO = /^[\p{L}\p{N}_-]{3,16}$/u;

function nomeSugerido() {
  const salvo = localStorage.getItem(NOME_GUARDADO);
  if (salvo) return salvo;
  // Um nome pronto é melhor que um campo vazio: quem só quer jogar aperta
  // Enter, e quem se importa apaga e escreve o seu.
  return `Piloto${((Math.random() * 9000) | 0) + 1000}`;
}

pilotInput.value = nomeSugerido();

/** @returns {string|null} o nome, ou `null` se inválido (já avisando na tela) */
function lerNome() {
  const nome = pilotInput.value.trim();
  if (NOME_VALIDO.test(nome)) {
    pilotInput.classList.remove('invalid');
    pilotHint.classList.remove('error');
    return nome;
  }

  pilotInput.classList.add('invalid');
  pilotHint.classList.add('error');
  pilotHint.textContent =
    nome.length < 3 ? 'Nome curto demais — mínimo 3 caracteres' : 'Use só letras, números, - e _';
  pilotInput.focus();
  return null;
}

/**
 * O nome com que este piloto assina — inclusive fora da sala.
 *
 * É o mesmo campo que vai no `join`, e por isso o crédito de uma descoberta
 * feita offline bate com o que apareceria online.
 */
function nomeDoPiloto() {
  return pilotInput.value.trim() || 'Piloto';
}

// A crítica some assim que a pessoa começa a corrigir: manter o vermelho
// enquanto ela digita é acusá-la de um erro que ela já está consertando.
pilotPass.addEventListener('input', () => pilotPass.classList.remove('invalid'));

pilotInput.addEventListener('input', () => {
  if (!pilotInput.classList.contains('invalid')) return;
  pilotInput.classList.remove('invalid');
  pilotHint.classList.remove('error');
  pilotHint.textContent = '3 a 16 caracteres · letras, números, - e _';
});

/* ========================================================================== */
/* Assets                                                                     */
/* ========================================================================== */

// Precisa acontecer ANTES de qualquer coisa que use modelos: `PropScatter` e
// `createShip()` consultam o AssetLibrary de forma SÍNCRONA no construtor. Essa
// é a razão de existir este await: com um carregamento preguiçoso, cada planeta
// teria que nascer com primitivas e trocar as malhas no meio do voo.
//
// São ~1,8 MB de .glb, uma única vez, enquanto os workers já geram terreno em
// paralelo — na prática não adiciona espera perceptível ao boot.
bootStatus.textContent = 'Carregando modelos…';
await assets.preload(allPreloadPaths());
await assets.prepareGeometries(propPaths());

if (assets.failed > 0) {
  // Não é fatal: cada sistema cai na primitiva equivalente. Mas é quase sempre
  // sinal de que `npm run assets` não foi rodado depois de clonar o repositório.
  console.warn(
    `[NMS] ${assets.failed} de ${assets.total} modelos não carregaram — usando primitivas. ` +
      'Rode "npm run assets".',
    assets.missing
  );
}

/* ========================================================================== */
/* Montagem                                                                   */
/* ========================================================================== */

const engine = new Engine(canvas);

const starSystem = new StarSystem(engine.scene, SEED);
const homePlanet = starSystem.planets[0];

const ship = createShip();
engine.scene.add(ship.group);
ship.group.position
  .copy(homePlanet.group.position)
  .add(new THREE.Vector3(homePlanet.radius * 0.35, homePlanet.radius * 0.55, homePlanet.radius * 2.1));
orientTowards(ship.group, homePlanet.group.position);

const shipController = new ShipController(ship.group, canvas);
const playerController = new PlayerController(canvas);
const warpLines = new WarpLines(engine.scene);

const gameState = new GameState(engine, starSystem);
const weather = new Weather(engine.scene, gameState);
const sombras = new SombrasDoSol(engine.renderer, starSystem.sunLight);

/* ========================================================================== */
/* Qualidade gráfica                                                          */
/* ========================================================================== */

const qualidade = new Qualidade();

/**
 * Aplica as preferências a quem as consome.
 *
 * Um ponto só, chamado no boot e a cada mudança no menu. A alternativa — cada
 * subsistema lendo as preferências por conta própria — espalharia a ordem de
 * aplicação por seis arquivos, e a ordem importa: o detalhe de superfície é
 * escrito em uniformes que só existem depois de o material compilar.
 */
function aplicarQualidade() {
  engine.definirTetoPixelRatio(qualidade.tetoPixelRatio);
  engine.definirEscalaResolucao(qualidade.escalaResolucao);
  engine.definirPos(qualidade.pos);
  sombras.definir(qualidade.sombras);
  cloudQuality.aplicar(qualidade.nuvens, qualidade.nuvensAuto);

  // O detalhe procedural do terreno é caro em fragmento (três oitavas de ruído
  // mais o gradiente para a normal) e é a primeira coisa que se pode perder sem
  // que a silhueta do mundo mude. Zerar as forças é mais barato que recompilar
  // um shader sem o bloco.
  for (const planeta of starSystem.planets) {
    const dados = planeta.chunks.material.userData;
    const u = dados.detalhe;
    const p = dados.detalhePadrao;
    if (!u || !p) continue;

    // O grão fino e o relevo são o que custa: alta frequência, avaliada por
    // fragmento, mais três amostras extras para o gradiente da normal. As
    // escalas macro e meso ficam mesmo no modo econômico — elas custam duas
    // avaliações de ruído e são o que impede o terreno de virar chapa lisa.
    const ligado = qualidade.detalheTerreno;
    u.uForcaGrao.value = ligado ? p.grao : 0;
    u.uForcaRelevo.value = ligado ? p.relevo : 0;
  }
}

qualidade.aoMudar(aplicarQualidade);
aplicarQualidade();

/**
 * Custo de GPU por quadro, em milissegundos.
 *
 * Usa `EXT_disjoint_timer_query_webgl2`, que é a única forma de medir o que a
 * GPU realmente gastou: o relógio da CPU só mede quanto tempo levou para
 * ENFILEIRAR os comandos, e num pipeline como este ele devolve valores dez
 * vezes menores que a verdade. Devolve `null` onde a extensão não existe (é
 * opcional, e alguns navegadores a escondem por impressão digital).
 */
async function medirGpu(repeticoes = 24) {
  const gl = engine.renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return null;

  for (let i = 0; i < 4; i++) engine.render(); // aquece: shader e cache
  const consulta = gl.createQuery();
  gl.beginQuery(ext.TIME_ELAPSED_EXT, consulta);
  for (let i = 0; i < repeticoes; i++) engine.render();
  gl.endQuery(ext.TIME_ELAPSED_EXT);

  // Prazo por RELÓGIO, não por número de tentativas: numa aba em segundo plano
  // o navegador estrangula `setTimeout` para um disparo por segundo, e um laço
  // de 120 tentativas passaria dois minutos preso mostrando "medindo…". Dois
  // segundos de parede é mais que suficiente — a consulta normalmente fica
  // pronta no quadro seguinte.
  const prazo = performance.now() + 2000;
  while (performance.now() < prazo) {
    await new Promise((r) => setTimeout(r, 16));
    // `GPU_DISJOINT` significa que o driver preemptou a fila no meio da medida;
    // o resultado existe mas não vale nada.
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) break;
    if (gl.getQueryParameter(consulta, gl.QUERY_RESULT_AVAILABLE)) {
      const ns = gl.getQueryParameter(consulta, gl.QUERY_RESULT);
      gl.deleteQuery(consulta);
      return ns / 1e6 / repeticoes;
    }
  }
  gl.deleteQuery(consulta);
  return null;
}

const menuPausa = new MenuPausa(qualidade, {
  niveisDeNuvem: cloudQuality.niveis,
  medir: () => medirGpu(),
  aoFechar: () => {
    requestPointerLock();
  },
});
const ceuAmbiente = new CeuAmbiente(engine.renderer, engine.scene);

// -----------------------------------------------------------------------------
// VITAIS
//
// Duas instâncias, e não uma: o jogador e a nave são alvos separados, com
// capacidades diferentes, e o dano num não pode escorrer para o outro. A nave
// aguenta bem mais porque quem atira nela são canhões de outra nave, não uma
// mordida — e porque perder a nave num planeta é bem pior que morrer a pé.
//
// Nada causa dano ainda; isto é a base que as armas, a fauna hostil e os drones
// vão usar. Ver `src/game/Vitals.js`.
// -----------------------------------------------------------------------------
const vitaisJogador = new Vitais({ escudoMaximo: 100, vidaMaxima: 100 });
const vitaisNave = new Vitais({ escudoMaximo: 260, vidaMaxima: 180 });

const projeteis = new Projeteis(engine.scene);
const blaster = new Blaster(projeteis);

/**
 * Quem atirou, para o projétil não acertar o próprio atirador.
 *
 * Um objeto vazio serve: a comparação é por identidade. Uma string ("jogador")
 * pareceria mais legível e criaria uma colisão silenciosa no dia em que outro
 * jogador da sala atirasse com o mesmo rótulo.
 */
const jogadorComoDono = {};

const sentinelas = new Sentinelas(engine.scene, projeteis);

/**
 * O jogador como ALVO, na mesma forma que a fauna e os drones.
 *
 * Poderia ser um caso especial dentro de `Projeteis` — "se o tiro é de um
 * inimigo, testar contra o jogador" — e seria pior: passariam a existir duas
 * regras de acerto, uma para o jogador e outra para todo o resto, livres para
 * divergirem na primeira correção. Aqui o teste de segmento contra esfera é
 * literalmente o mesmo.
 *
 * O `dono` é o que impede o jogador de levar o próprio tiro.
 */
const alvoJogador = {
  posicao: new THREE.Vector3(),
  raio: 0.85,
  vitais: vitaisJogador,
  dono: jogadorComoDono,
};

/** Lista única de alvos do quadro. Reaproveitada: roda a 60 Hz em combate. */
const _alvos = [];
function montarAlvos() {
  _alvos.length = 0;
  for (const a of activePlanet.fauna.alvos()) _alvos.push(a);
  for (const a of sentinelas.alvos()) _alvos.push(a);

  // A pé o alvo é o traje; pilotando, o casco — e o raio muda junto, porque
  // acertar uma nave é bem mais fácil que acertar uma pessoa.
  const aPe = mode === 'FOOT';
  alvoJogador.posicao.copy(aPe ? playerController.position : ship.group.position);
  alvoJogador.vitais = aPe ? vitaisJogador : vitaisNave;
  alvoJogador.raio = aPe ? 0.85 : 2.4;
  _alvos.push(alvoJogador);

  return _alvos;
}

/**
 * O que acontece quando um tiro encosta em alguma coisa.
 *
 * Mora aqui, e não dentro de `Weapons.js`, porque a reação depende de coisas que
 * o transporte não conhece nem deveria: o planeta ativo, a rede, o áudio e a
 * interface. O módulo de projéteis só avisa que houve impacto e onde.
 */
projeteis.aoImpactar = (impacto) => {
  if (impacto.explodiu) {
    const e = impacto.explosao;
    audio.terraform(false);

    // --- Cratera ---------------------------------------------------------
    // Direto no campo de edições, sem passar pelo `Terraform`: aquele é um
    // escultor COM ESTADO, feito para o botão segurado, que agrupa quadros
    // consecutivos na mesma edição. Uma granada é um evento único, e reutilizar
    // o escultor faria duas granadas próximas se fundirem num buraco só.
    _reference.copy(impacto.ponto);
    const amostra = activePlanet.sampleAt(_reference);
    // Só abre cratera se explodiu perto do chão: uma granada que erra e some no
    // ar não pode cavar o terreno a cem unidades abaixo dela.
    if (amostra.altitude < 4) {
      const edicao = {
        id: `gr${(Math.random() * 1e9) | 0}`,
        x: amostra.direction.x,
        y: amostra.direction.y,
        z: amostra.direction.z,
        r: e.raioCratera,
        f: e.cratera,
        t: EDICAO.SOMAR,
      };
      if (activePlanet.aplicarEdicao(edicao)) {
        multiplayer?.terraformou(starSystem.planets.indexOf(activePlanet), edicao);
      }
    }

    // --- Dano em área ----------------------------------------------------
    // Cai com a distância em vez de ser chapado no raio: dano uniforme faz a
    // borda da explosão virar uma parede invisível, onde meio passo separa
    // levar tudo de não levar nada.
    for (const alvo of activePlanet.fauna.alvos()) {
      const d = alvo.posicao.distanceTo(impacto.ponto);
      if (d > e.raio) continue;
      alvo.vitais.aplicarDano(e.dano * (1 - d / e.raio), impacto.dono);
    }
    return;
  }

  if (!impacto.alvo) return;

  // O jogador levando tiro: o clarão é o único aviso, porque um projétil de
  // drone vindo de trás não aparece na tela de jeito nenhum.
  if (impacto.alvo === alvoJogador) {
    hud.pulsarDano();
    if (impacto.morreu) hud.notify('VOCÊ FOI ABATIDO', 3);
    return;
  }

  audio.collect();
  if (!impacto.morreu) return;

  if (impacto.alvo.drone) {
    // Espólio: peças de tecnologia. Abater sentinela tem de PAGAR, senão o
    // jogador só evita o conflito e o sistema inteiro vira um imposto.
    const ganho = inventory.add('ferrite', 2 + ((Math.random() * 3) | 0));
    hud.notify(ganho ? 'SENTINELA DESTRUÍDA · +SUCATA' : 'SENTINELA DESTRUÍDA', 1.6);
  } else {
    hud.notify('CRIATURA ABATIDA', 1.4);
    // Abater fauna é a infração mais pesada da lista. Ver `Sentinelas`.
    sentinelas.registrarInfracao(0.5);
  }
};

/**
 * Inscreve o retorno de ataque da fauna do planeta ativo.
 *
 * Precisa ser reinscrito, e não feito uma vez no boot: cada planeta tem sua
 * própria instância de `Fauna`, e o jogador troca de corpo sem que nada aqui
 * seja reconstruído. Sem isto, pousar na segunda lua daria criaturas que
 * perseguem e mordem sem nunca tirar um ponto de vida.
 *
 * A guarda de identidade evita reatribuir a mesma função a cada quadro.
 */
let faunaInscrita = null;
function ligarAtaquesDaFauna(planeta) {
  if (faunaInscrita === planeta.fauna) return;
  faunaInscrita = planeta.fauna;

  planeta.fauna.aoAtacar = (dano) => {
    // Dentro da nave o jogador não é mordido: o casco é que apanha. Sem esta
    // distinção, pousar no meio de uma matilha drenaria o traje através de duas
    // toneladas de blindagem.
    const alvo = mode === 'FOOT' ? vitaisJogador : vitaisNave;
    const golpe = alvo.aplicarDano(dano, 'fauna');
    if (golpe.vida > 0 || golpe.escudo > 0) {
      audio.terraform(true);
      hud.pulsarDano?.();
    }
    if (golpe.letal) hud.notify('VOCÊ FOI ABATIDO', 3);
  };
}
const inventory = new Inventory();
const discovery = new Discovery();
const scanner = new Scanner(engine.scene);
const hud = new HUD();

// A construção carrega o próprio kit de modelos. Fica FORA do `allPreloadPaths`
// porque nada dela passa pela normalização de altura do AssetLibrary — ver o
// cabeçalho de `assets/buildings.js`.
const build = new BuildSystem({ starSystem, inventory });
const terraform = new Terraform(starSystem, engine.scene);
const viewModel = new ViewModel();
engine.overlay = viewModel;

bootStatus.textContent = 'Carregando kit de construção…';
await build.preparar();
await viewModel.preparar(caminhosDeFerramentas());

/* ========================================================================== */
/* Equipamento                                                                */
/* ========================================================================== */

/**
 * Índice em `FERRAMENTAS`.
 *
 * Uma variável só governa o que o clique faz, o que aparece na mão e o que fica
 * aceso na barra — as três coisas que antes discordavam entre si. Ver o
 * cabeçalho de `game/Tools.js`.
 */
let ferramenta = 0;
const ferramentaAtual = () => FERRAMENTAS[ferramenta];

function equipar(indice) {
  const alvo = ((indice % FERRAMENTAS.length) + FERRAMENTAS.length) % FERRAMENTAS.length;
  if (alvo === ferramenta) return;
  ferramenta = alvo;

  // O modo construção acompanha a ferramenta: era um estado paralelo que dava
  // para ligar segurando o terraformador, e ninguém entendia por que o clique
  // não construía.
  build.alternar(ferramentaAtual().id === 'construtor');
  viewModel.equipar(ferramentaAtual().modelo);
  audio.ui(true);
  hud.notify(ferramentaAtual().nome.toUpperCase(), 1.4);
}

viewModel.equipar(ferramentaAtual().modelo);
hud.ligarPainel({ aoEscolherPeca: (indice) => escolherPecaDoCatalogo(indice) });

/* ========================================================================== */
/* Mapa galáctico e salto                                                     */
/* ========================================================================== */

/**
 * Alcance do hiperimpulsor, em voxels do mapa (≈ anos-luz).
 *
 * Curto de propósito. Um alcance que cobrisse a galáxia inteira transformaria
 * o mapa num menu de teletransporte e apagaria a única decisão que ele oferece:
 * qual salto dar em seguida. Com cinco, chegar ao outro lado é uma sequência de
 * escolhas, e um sistema fora de alcance é um destino, não um erro.
 */
const ALCANCE_SALTO = 5;

let galaxiaAtual = 0;

const galaxyMap = new GalaxyMap({
  podeSaltar: (sistema) => {
    if (!galaxyMap.atual) return false;
    if (sistema.galaxia !== galaxyMap.atual.galaxia) return false;
    const d = Math.hypot(
      sistema.x - galaxyMap.atual.x,
      sistema.y - galaxyMap.atual.y,
      sistema.z - galaxyMap.atual.z
    );
    return d > 0 && d <= ALCANCE_SALTO;
  },
});
galaxyMap.alcance = ALCANCE_SALTO;
galaxyMap.situar(galaxiaAtual, starSystem.seed);
engine.mapa = galaxyMap;

const warp = new WarpJump();
warp.acoplar(viewModel.camera);

/* ========================================================================== */
/* Origem flutuante                                                           */
/* ========================================================================== */

// Tudo que guarda posição de MUNDO precisa estar aqui. O rebase é atômico: um
// objeto esquecido não fica "um pouco errado", ele salta milhares de unidades
// de uma vez. Ver `core/FloatingOrigin.js`.
//
// O que deliberadamente NÃO entra:
//   - campo de estrelas e sprite do sol: acompanham a câmera todo frame de
//     propósito (estrelas não têm paralaxe);
//   - luz direcional: só a direção importa, e ela é reescrita todo frame;
//   - props, fauna e chunks: vivem no espaço LOCAL do planeta e andam junto
//     com o grupo dele de graça.
const floatingOrigin = new FloatingOrigin(4096);

/**
 * (Re)inscreve tudo que guarda posição de mundo.
 *
 * É uma função e não um bloco solto porque o salto interestelar troca os
 * planetas: os `group` inscritos aqui deixariam de existir, e o rebase seguinte
 * empurraria objetos órfãos enquanto os novos ficariam parados — o mundo
 * inteiro deslizando por baixo da nave.
 */
function inscreverNaOrigemFlutuante() {
  floatingOrigin
    .limpar()
    .add(...starSystem.planets.map((planet) => planet.group))
    .add(ship.group, scanner.pulse, scanner.beam, terraform.marcador)
    .addVector(playerController.position)
    // Os tiros guardam posição de cena por conta própria (a malha instanciada
    // fica na origem), então precisam de tratamento e não de deslocamento do
    // objeto. Sem isto, cada recentragem lançaria todo tiro vivo a milhares de
    // unidades — e como o rebase acontece justamente ao voar rápido, o sintoma
    // apareceria só no combate de naves.
    .onShift((delta) => {
      projeteis.deslocar(delta);
      sentinelas.deslocar(delta);
    });
}

inscreverNaOrigemFlutuante();

/* ========================================================================== */
/* Multijogador                                                               */
/* ========================================================================== */

/**
 * LIGADO POR PADRÃO.
 *
 * A primeira versão exigia `?mp=1` na URL, e o efeito foi o previsível: abrir o
 * jogo normalmente não entrava em sala nenhuma, dois navegadores lado a lado
 * não se viam e o painel da sala nem aparecia — porque ele só era mostrado
 * quando havia conexão. Um recurso que precisa de um parâmetro secreto para
 * existir é um recurso que ninguém usa.
 *
 * Sem servidor no ar não acontece nada de ruim: a tentativa falha em silêncio,
 * o painel diz OFFLINE e o jogo segue igual. O cliente continua tentando, então
 * subir o servidor depois basta — não é preciso recarregar.
 *
 *   `?mp=off`            joga sozinho, sem nem tentar
 *   `?mp=ws://host:5200` aponta para outra máquina
 */
/**
 * Descobre o endereço da sala, em ordem de prioridade.
 *
 * @returns {string|null} `null` = jogar sozinho, sem nem criar o cliente
 */
function enderecoDaSala() {
  const mpParam = params.get('mp');
  if (mpParam === 'off') return null;
  if (mpParam && mpParam !== '1') return mpParam;

  // Configurado na hospedagem, editando o `index.html` publicado.
  const meta = document.querySelector('meta[name="nms-mp-server"]')?.content?.trim();
  if (meta) return meta;

  // Em desenvolvimento e em rede local, a sala roda ao lado (`npm run mp`).
  if (enderecoDeRedeLocal(location.hostname)) {
    return `ws://${location.hostname || 'localhost'}:5200`;
  }

  // Publicado e sem servidor declarado: modo solo. Tentar um endereço
  // adivinhado só encheria o console de erro em cada visita.
  return null;
}

/**
 * O jogo está sendo servido de uma máquina da própria rede?
 *
 * ---------------------------------------------------------------------------
 * POR QUE NÃO BASTA TESTAR `localhost`
 * ---------------------------------------------------------------------------
 * A versão anterior só reconhecia `localhost` e `127.0.0.1`, e o efeito era
 * silencioso e desconcertante: abrir o jogo do computador ao lado, pelo IP da
 * rede, caía no ramo "publicado sem servidor declarado" e o multijogador se
 * DESLIGAVA sozinho. O painel dizia OFFLINE, nenhum erro aparecia no console, e
 * a sala rodando na outra ponta ficava esperando alguém que nunca ia chegar.
 *
 * Ou seja: o único cenário em que duas pessoas de fato jogam juntas era o único
 * em que o jogo decidia jogar sozinho.
 *
 * O reconhecimento cobre as três faixas privadas da RFC 1918, os nomes `.local`
 * (mDNS) e os nomes de máquina sem ponto, que é como um PC aparece numa rede
 * doméstica Windows. Um domínio público continua caindo no modo solo, e é isso
 * mesmo: lá o endereço precisa ser declarado na meta tag, porque quase sempre é
 * `wss://` atrás de um proxy.
 */
function enderecoDeRedeLocal(hostname) {
  if (!hostname) return true; // `file://` e afins
  if (hostname === 'localhost' || hostname === '::1' || hostname.endsWith('.local')) return true;
  if (/^127\./.test(hostname)) return true;

  // Nome de máquina sem ponto: `PEDRO-PC`, `desktop`, resolvido pela rede local.
  if (!hostname.includes('.') && !hostname.includes(':')) return true;

  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

const enderecoSala = enderecoDaSala();

// Conteúdo misto: uma página https NÃO abre `ws://`. O navegador bloqueia e o
// erro é fácil de não notar — melhor dizer exatamente o que está errado.
if (enderecoSala && location.protocol === 'https:' && enderecoSala.startsWith('ws://')) {
  console.error(
    `[NMS] a sala está em ${enderecoSala}, mas a página é https e o navegador vai bloquear. ` +
      'Use wss:// (ver a meta tag "nms-mp-server" no index.html).'
  );
}

const multiplayer = enderecoSala
  ? new Multiplayer({
      scene: engine.scene,
      starSystem,
      url: enderecoSala,
      seed: SEED,
      seedExplicito: SEED_EXPLICITO,
      aviso: (texto) => hud.notify(texto, 2.6),
      // A sala é a dona das construções: tudo que chega — de outro jogador ou
      // do banco, no momento de entrar — passa pelo mesmo `aplicar`.
      aoConstruir: (evento) => build.aplicar(evento),
      /**
       * @param {boolean} emBloco restauração ao entrar na sala
       *
       * Os dois caminhos existem por causa de uma CORRIDA que só aparece ao
       * entrar: o terreno começa a ser gerado no boot, muito antes de o
       * `welcome` chegar. Aplicar as escavações uma a uma nesse momento
       * invalida chunks que ainda não existem e deixa passar os que estão em
       * voo — o resultado era uma cratera presente no amostrador (colisão e
       * altitude corretas) e ausente na malha, um buraco em que dava para
       * andar sobre o nada.
       *
       * `definirEdicoes` reenvia a lista inteira aos workers e derruba a
       * região de cada uma DEPOIS que todas estão registradas, o que resolve a
       * ordem de uma vez em vez de torcer para ela dar certo.
       */
      aoTerraformar: (planetaId, lista, emBloco = false) => {
        const planeta = starSystem.planets[planetaId];
        if (!planeta) return;
        if (emBloco) planeta.definirEdicoes(lista);
        else for (const edicao of lista) planeta.aplicarEdicao(edicao);
      },
      aoExpirarTerreno: (planetaId, ids) => {
        const planeta = starSystem.planets[planetaId];
        if (!planeta) return;
        for (const id of ids) planeta.removerEdicao(id);
      },
      /**
       * Uma descoberta — do catálogo que chega ao entrar ou de alguém que
       * acabou de chegar num sistema inédito.
       *
       * O aviso só sai para descobertas NOVAS de outra pessoa: repetir as
       * centenas do catálogo inicial encheria a tela no primeiro segundo de
       * sala, e anunciar a própria descoberta duplicaria o texto que
       * `reivindicarDescoberta` já mostra.
       */
      aoChat: (linha) => hud.escreverNoChat(linha),
      aoDescobrir: (registro, inicial = false) => {
        if (!galaxyMap.registrarDescoberta(registro)) return;
        if (inicial) return;
        hud.notify(
          registro.descobridor === nomeDoPiloto()
            ? `SISTEMA INÉDITO: ${registro.nome.toUpperCase()} É SEU`
            : `${registro.descobridor.toUpperCase()} DESCOBRIU ${registro.nome.toUpperCase()}`,
          3.4
        );
      },
    })
  : null;
multiplayer?.conectar();

/** 'SHIP' | 'FOOT' */
let mode = 'SHIP';
let activePlanet = homePlanet;

shipController.updateCamera(engine.camera, 1);

/**
 * Aponta o -Z de um objeto para um alvo.
 * `Object3D.lookAt()` NÃO serve: para objetos que não são câmera/luz ele
 * alinha o +Z, o oposto da convenção usada pela nave.
 */
/**
 * Aponta o nariz do objeto (−Z) para um ponto.
 *
 * `cima` é opcional e existe para quem tem uma referência de rolagem melhor que
 * o Y do mundo — perto de um planeta, o "para cima" que importa é o radial.
 */
function orientTowards(object, target, cima) {
  const matrix = new THREE.Matrix4().lookAt(object.position, target, cima ?? object.up);
  object.quaternion.setFromRotationMatrix(matrix);
}

/* ========================================================================== */
/* Tela de abertura                                                           */
/* ========================================================================== */

let started = false;
let spawnApplied = false;
/** O jogador foi recolocado onde parou? Muda o aviso de entrada e trava o `?spawn`. */
let voltouAoPonto = false;
const CHUNKS_TO_BOOT = 30;

/** Enter no campo do nome faz o mesmo que clicar em INICIAR VOO. */
pilotForm.addEventListener('submit', (evento) => {
  evento.preventDefault();
  if (!startButton.disabled) iniciar();
});

startButton.addEventListener('click', () => iniciar());

async function iniciar() {
  if (startButton.disabled || started) return;

  const nome = lerNome();
  if (!nome) return; // a crítica já está na tela; não começa o jogo

  // --- Conta (opcional) ---------------------------------------------------
  // Só entra neste caminho quem digitou senha. Sem senha o jogo começa igual
  // ao que sempre foi — apenas não salva. Exigir conta para ver um planeta
  // girar seria cobrar um pedágio antes de mostrar o que se está vendendo.
  const senha = pilotPass.value;
  if (senha && multiplayer) {
    startButton.disabled = true;
    startButton.textContent = 'ENTRANDO…';

    const resposta = await multiplayer.autenticar(nome, senha);

    startButton.disabled = false;
    startButton.textContent = 'INICIAR VOO';

    if (!resposta.ok) {
      pilotPass.classList.add('invalid');
      pilotHint.classList.add('error');
      pilotHint.textContent = resposta.erro ?? 'não foi possível entrar';
      return;
    }

    if (resposta.progresso) {
      inventory.restaurar(resposta.progresso.inventario);
      discovery.restaurar(resposta.progresso.descobertas);
      if (typeof resposta.progresso.unidades === 'number') inventory.units = resposta.progresso.unidades;

      // O cenário de URL é ferramenta de teste e manda mais que o save: quem
      // abre com `?spawn=orbita` quer ver a órbita, não voltar para onde parou.
      if (!params.has('spawn')) voltouAoPonto = restaurarPosicao(resposta.progresso.posicao);
    }
    contaAtiva = true;
  }

  localStorage.setItem(NOME_GUARDADO, nome);
  multiplayer?.identificar(nome);

  started = true;
  // Reaplica agora que o mundo desenhou pelo menos uma vez: os uniformes de
  // detalhe do terreno só existem depois de `onBeforeCompile` rodar, e no boot
  // ainda não existiam. Sem isto, quem escolheu o perfil de desempenho voltaria
  // ao jogo com o detalhe caro ligado.
  aplicarQualidade();
  // Já restauramos a posição salva; deixar o cenário de URL rodar depois a
  // sobrescreveria alguns frames adiante, e o jogador veria um salto.
  if (voltouAoPonto) spawnApplied = true;

  overlay.classList.add('fade-out');
  hud.show();
  requestPointerLock();
  // O `AudioContext` PRECISA nascer aqui: este é o gesto do usuário que o
  // navegador exige. Criado no boot, ele nasceria suspenso e o jogo ficaria
  // mudo sem nenhum erro. Ver o cabeçalho de `audio/AudioEngine.js`.
  audio.start();
  if (contaAtiva) hud.notify('PROGRESSO RESTAURADO', 2.6);
  hud.notify(
    voltouAoPonto ? `DE VOLTA A ${activePlanet.name.toUpperCase()}` : `SISTEMA ${homePlanet.name.toUpperCase()}`,
    3.5
  );
}

// A cena de sobreposição tem câmera própria e não passa pelo resize do Engine.
window.addEventListener('resize', () => {
  const aspecto = window.innerWidth / window.innerHeight;
  viewModel.redimensionar(aspecto);
  galaxyMap.redimensionar(aspecto);
});
viewModel.redimensionar(window.innerWidth / window.innerHeight);
galaxyMap.redimensionar(window.innerWidth / window.innerHeight);

canvas.addEventListener('click', () => {
  requestPointerLock();
  // Voltar de outra aba deixa o contexto suspenso; retomar é idempotente.
  audio.start();
});

/**
 * O cursor precisa estar VISÍVEL e livre agora?
 *
 * ===========================================================================
 * FONTE ÚNICA DE VERDADE, DEPOIS DE UM BUG QUE APARECEU DUAS VEZES
 * ===========================================================================
 * Antes, cada modo cuidava do ponteiro por conta própria — o mapa chamava
 * `exitPointerLock` ao abrir, o painel também, o menu de pausa idem. E o
 * ouvinte de clique do canvas, que não sabia de nenhum deles, RETRAVAVA o
 * ponteiro no clique seguinte.
 *
 * O efeito era o relatado: abrir o menu de pausa, clicar em qualquer coisa e o
 * cursor sumir, deixando o menu impossível de usar. No mapa galáctico era pior,
 * porque lá o alvo do clique é o próprio canvas — selecionar uma estrela
 * travava o ponteiro e o mapa deixava de responder ao mouse.
 *
 * A correção não é acrescentar mais uma chamada de `exitPointerLock`: é ter UM
 * lugar que responde "o cursor está livre?", e fazer com que tanto o pedido de
 * travamento quanto os manipuladores de botão o consultem. Qualquer modo novo
 * que precise do cursor entra nesta lista e funciona de imediato.
 */
function cursorLivre() {
  return !started || menuPausa.aberto || galaxyMap.aberto || painelAberto || !!hud.chat?.aberto;
}

function requestPointerLock() {
  if (cursorLivre()) return;
  // Pode rejeitar por motivos fora do nosso controle (documento aninhado,
  // política do navegador). O jogo continua jogável no teclado.
  canvas.requestPointerLock?.()?.catch?.(() => {});
}

/**
 * Solta o ponteiro e garante que ele não volte no próximo clique.
 *
 * Chamado por quem abre um modo de cursor livre. O `exitPointerLock` sozinho
 * não basta — é `cursorLivre()` que impede o retravamento —, mas sem ele o
 * cursor só reapareceria no próximo movimento do mouse.
 */
function soltarPonteiro() {
  document.exitPointerLock?.();
}

/* ========================================================================== */
/* Cenários de teste por URL                                                  */
/* ========================================================================== */

/**
 * `?spawn=<cenário>` põe a nave direto numa situação e pula a tela de abertura.
 *
 * Existe porque conferir uma mudança visual — cor de folhagem, nuvem, névoa —
 * exigia decolar, voar até o planeta e pousar toda vez. Com isto, abrir a URL
 * já é o teste. `&planet=N` escolhe o corpo (padrão: o inicial).
 *
 *   superficie  pousado, olhando o horizonte
 *   orbita      a 2,5 raios, com o planeta enquadrado
 *   alto        dentro da atmosfera alta, olhando para baixo
 *
 * Não afeta o jogo normal: sem o parâmetro, nada disto roda.
 */
function applySpawnScenario() {
  const spawn = params.get('spawn');
  if (!spawn) return;

  const index = Number(params.get('planet') ?? 0) || 0;
  const planet = starSystem.planets[index] ?? homePlanet;
  const up = new THREE.Vector3(0.3, 0.9, 0.2).normalize();
  const sample = planet.sampleAt(
    planet.group.position.clone().addScaledVector(up, planet.radius * 2)
  );

  const alturas = { superficie: 9, alto: planet.config.atmosphere.height * 0.55 };
  if (spawn === 'orbita') {
    ship.group.position.copy(planet.group.position).addScaledVector(up, planet.radius * 2.5);
    orientTowards(ship.group, planet.group.position);
  } else {
    const altura = alturas[spawn] ?? 9;
    ship.group.position.copy(planet.group.position).addScaledVector(up, sample.surfaceRadius + altura);
    // Olhando o horizonte: a tangente é o que mostra relevo, névoa e céu no
    // mesmo quadro — que é justamente o que se quer julgar.
    const tangente = new THREE.Vector3(1, 0, 0).cross(up).normalize();
    orientTowards(ship.group, ship.group.position.clone().add(tangente));
  }

  shipController.velocity.set(0, 0, 0);
  shipController.throttle = 0;
  activePlanet = planet;

  // O cenário de URL pula a tela inicial, então o nome vem do que estiver
  // guardado — sem isto, abrir com `?spawn=` entraria na sala sem `join` e o
  // jogador ficaria invisível para os outros.
  multiplayer?.identificar(pilotInput.value.trim() || 'Piloto');

  started = true;
  aplicarQualidade(); // ver a nota no outro ponto de início
  overlay.classList.add('fade-out');
  hud.show();
}

/* ========================================================================== */
/* Entrar e sair da nave                                                      */
/* ========================================================================== */

const BOARDING_RANGE = 14;
const _shipToPlayer = new THREE.Vector3();
const _lookDir = new THREE.Vector3();
const _eye = new THREE.Vector3();

function canBoard() {
  return mode === 'FOOT' && playerController.position.distanceTo(ship.group.position) < BOARDING_RANGE;
}

function canDisembark() {
  return mode === 'SHIP' && shipController.landed;
}

/**
 * Passos a pé.
 *
 * Um temporizador fixo daria passos na mesma cadência andando e correndo, o
 * que soa como um metrônomo desligado das pernas. Acumular DISTÂNCIA percorrida
 * amarra o som ao movimento de graça: correr aumenta a cadência sozinho, e
 * parar no meio de um passo não dispara nada.
 */
let stepAccumulator = 0;
const STEP_LENGTH = 2.6;

function updateFootsteps(dt) {
  if (mode !== 'FOOT' || !playerController.grounded) {
    stepAccumulator = 0;
    return;
  }
  const speed = playerController.speed;
  if (speed < 0.5) return;

  stepAccumulator += speed * dt;
  if (stepAccumulator >= STEP_LENGTH) {
    stepAccumulator -= STEP_LENGTH;
    audio.step(speed > 12);
  }
}

function disembark() {
  // Nasce ao lado da nave, não dentro dela: sair "dentro" da geometria da nave
  // empurraria o jogador para fora de forma imprevisível na primeira colisão.
  const side = new THREE.Vector3(1, 0, 0).applyQuaternion(ship.group.quaternion).multiplyScalar(6);
  const spawn = ship.group.position.clone().add(side);

  const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.group.quaternion);
  playerController.spawnAt(spawn, activePlanet, facing);
  playerController.enabled = true;
  mode = 'FOOT';
  audio.ui(false);
  hud.notify('FORA DA NAVE', 2.0);
}

function board() {
  // Embarcar com o construtor na mão deixaria o fantasma pendurado no espaço e
  // a roda do mouse trocando peças enquanto se pilota.
  build.alternar(false);
  botao.esquerdo = botao.direito = false;
  terraform.soltar();
  playerController.enabled = false;
  mode = 'SHIP';
  shipController.velocity.set(0, 0, 0);
  shipController.throttle = 0;
  audio.ui(true);
  hud.notify('A BORDO', 2.0);
}

// A caixa de chat é ligada uma vez; o envio devolve `false` sem sala, e aí a
// própria interface avisa em vez de engolir a linha.
hud.ligarChat((texto, alcance) => multiplayer?.falar(texto, alcance) ?? false);

window.addEventListener('keydown', (event) => {
  if (!started || event.ctrlKey || event.metaKey || event.altKey) return;

  // -------------------------------------------------------------------------
  // O CHAT VEM ANTES DE TUDO, INCLUSIVE DO MAPA.
  //
  // Com a caixa aberta, o teclado inteiro pertence a ela: `N` precisa escrever
  // um "n", não abrir o mapa galáctico. O `keydown` do input já para a
  // propagação, então chegar aqui com o chat aberto significa que o foco se
  // perdeu — e nesse caso a saída segura é fechar.
  // -------------------------------------------------------------------------
  if (hud.chat.aberto) {
    if (document.activeElement !== hud.chat.input) hud.fecharChat();
    return;
  }

  // Enter abre a linha de digitação. Fica fora do mapa e do painel: conversar
  // é possível a qualquer momento, menos com outra caixa de texto na tela.
  if (event.code === 'Enter' && !galaxyMap.aberto && !painelAberto) {
    event.preventDefault();
    hud.abrirChat();
    return;
  }

  // -------------------------------------------------------------------------
  // O MAPA VEM ANTES DE TUDO.
  //
  // Com ele aberto, o jogo continua rodando por baixo — a nave está em voo
  // livre no espaço. Se as teclas normais chegassem aqui, `F` faria desembarcar
  // no vazio e os dígitos trocariam de ferramenta enquanto se lê o mapa. O
  // `return` fecha o restante do teclado enquanto o mapa manda.
  //
  // `N` de navegação, e não `M`: `M` já é o mudo, e duas ações na mesma tecla é
  // exatamente o que este arquivo passou a não fazer.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // ESCAPE ABRE A PAUSA, e vem antes de tudo.
  //
  // Precisa ser a PRIMEIRA coisa testada porque é a tecla de saída universal: se
  // qualquer bloco acima puder consumi-la, existe um estado em que o jogador
  // aperta Escape e nada acontece — e é justamente no estado travado que ele
  // mais precisa dela. Os modos que dão outro sentido ao Escape (mapa, chat,
  // painel) tratam disso fechando a si mesmos primeiro.
  // -------------------------------------------------------------------------
  if (event.code === 'Escape') {
    if (hud.chat?.aberto) return; // o próprio campo já limpa e fecha
    if (galaxyMap.aberto) { fecharMapa(); return; }
    if (painelAberto) { alternarPainel(false); return; }
    menuPausa.alternar();
    return;
  }

  if (event.code === 'KeyN') {
    alternarMapa();
    return;
  }

  if (galaxyMap.aberto) {
    if (event.code === 'Escape') fecharMapa();
    else if (event.code === 'Enter' || event.code === 'KeyJ') saltarPara(galaxyMap.selecionado);
    else if (event.code === 'KeyC') galaxyMap.centralizarNoAtual();
    else if (event.code === 'KeyF') galaxyMap.centralizarNoSelecionado();
    // Colchetes trocam de galáxia: navegação de catálogo, sem colisão com voo.
    else if (event.code === 'BracketLeft') galaxyMap.trocarGalaxia(-1);
    else if (event.code === 'BracketRight') galaxyMap.trocarGalaxia(1);
    else eixosDoMapa(event.code, 1);
    return;
  }

  if (event.code === 'KeyF') {
    if (canDisembark()) disembark();
    else if (canBoard()) board();
  }

  if (event.code === 'KeyV' && mode === 'FOOT') {
    runScan();
  }

  // -------------------------------------------------------------------------
  // UM COMANDO POR TECLA
  //
  // As três regras abaixo existiam de forma ambígua e foram separadas:
  //
  //   - os dígitos casavam `[1-9]` e o índice entrava num módulo, então a
  //     tecla `4` equipava silenciosamente a primeira ferramenta. Agora só
  //     valem os dígitos que correspondem a uma ferramenta de verdade;
  //   - `R` girava a peça e `Shift+R` girava ao contrário — mas `Shift` é
  //     correr, então girar para trás fazia o jogador disparar junto. `R` gira
  //     num sentido só; quatro toques dão a volta completa;
  //   - a roda do mouse trocava de PEÇA ou de FERRAMENTA conforme o que
  //     estivesse na mão. Agora ela tem um significado só (equipamento) e a
  //     peça anda em `Q`/`E`.
  // -------------------------------------------------------------------------
  if (mode === 'FOOT') {
    const digito = event.code.match(/^Digit([1-9])$/);
    if (digito) {
      const indice = Number(digito[1]) - 1;
      if (indice < FERRAMENTAS.length) {
        event.preventDefault();
        equipar(indice);
      }
    }

    // Atalho direto para o construtor: é a ferramenta que mais se alterna, e
    // caçá-la na barra a cada parede seria fricção pura.
    if (event.code === 'KeyB') equipar(FERRAMENTAS.findIndex((f) => f.id === 'construtor'));

    if (build.ativo) {
      if (event.code === 'KeyR') build.girar(1);
      if (event.code === 'KeyQ') build.selecionar(-1);
      if (event.code === 'KeyE') build.selecionar(1);
    }
  }

  // --- Painel de inventário e catálogo ------------------------------------
  if (event.code === 'Tab') {
    event.preventDefault();
    alternarPainel();
  }

  if (event.code === 'KeyM') {
    hud.notify(audio.toggleMute() ? 'SOM DESLIGADO' : 'SOM LIGADO', 1.6);
  }

  if (event.code === 'F3') {
    event.preventDefault();
    // Wireframe revela a quadtree: dá para ver os chunks subdividindo ao vivo.
    for (const planet of starSystem.planets) {
      planet.chunks.material.wireframe = !planet.chunks.material.wireframe;
    }
  }
});

/**
 * Teclas de voo DENTRO do mapa.
 *
 * As mesmas do voo normal — WASD para o plano, R/F para subir e descer — porque
 * são as que a mão já está usando quando o mapa abre. `mover` no `GalaxyMap`
 * traduz os eixos para o referencial da câmera.
 *
 * @param {string} codigo `event.code`
 * @param {0|1} valor 1 ao pressionar, 0 ao soltar
 * @returns {boolean} se a tecla era de movimento
 */
function eixosDoMapa(codigo, valor) {
  const e = galaxyMap.eixos;
  switch (codigo) {
    case 'KeyW': case 'ArrowUp': e.frente = valor; return true;
    case 'KeyS': case 'ArrowDown': e.frente = -valor; return true;
    case 'KeyD': case 'ArrowRight': e.lado = valor; return true;
    case 'KeyA': case 'ArrowLeft': e.lado = -valor; return true;
    // Subir e descer NÃO usam `F`: no mapa essa tecla já centraliza no destino,
    // e a checagem dela vem antes desta função. Duas ações na mesma tecla é
    // exatamente o que o resto do teclado deste arquivo evita.
    case 'KeyR': case 'Space': e.cima = valor; return true;
    case 'KeyQ': case 'ShiftLeft': e.cima = -valor; return true;
    default: return false;
  }
}

window.addEventListener('keyup', (event) => {
  if (galaxyMap.aberto) eixosDoMapa(event.code, 0);
});

/* ========================================================================== */
/* Multiferramenta                                                            */
/* ========================================================================== */

/**
 * Botões pressionados agora.
 *
 * Guardar o ESTADO, e não só o evento, é o que permite ações contínuas
 * (minerar, cavar) conviverem com ações instantâneas (construir) sem cada uma
 * inventar o próprio rastreamento.
 */
const botao = { esquerdo: false, direito: false };

/* --- Mouse dentro do mapa ------------------------------------------------- */

/**
 * O mapa usa o cursor LIVRE, sem pointer lock.
 *
 * É o oposto do resto do jogo, e de propósito: apontar uma estrela entre
 * milhares exige mirar com precisão absoluta na tela, e um cursor travado só
 * entrega movimento relativo. É também por isso que abrir o mapa solta o
 * ponteiro e fechá-lo o retoma.
 */
let arrastando = false;
let deslizando = false;

canvas.addEventListener('mousedown', (event) => {
  if (galaxyMap.aberto) {
    // -----------------------------------------------------------------------
    // ARRASTAR SEMPRE GIRA — mesmo começando em cima de uma estrela.
    //
    // Antes o botão esquerdo só girava se o clique caísse no VAZIO; sobre uma
    // estrela ele selecionava e a câmera ficava presa. Num campo com milhares
    // de pontos, encontrar vazio para começar a girar é uma caça, e o mapa dava
    // a impressão de travar aleatoriamente.
    //
    // Perder a seleção por clique não custa nada: quem seleciona é o cursor ao
    // passar por cima (ver `mousemove`), então a estrela já está escolhida
    // antes de o botão descer.
    // -----------------------------------------------------------------------
    if (event.button === 0) arrastando = true;
    else if (event.button === 2) deslizando = true;
    return;
  }

  // `cursorLivre()` cobre pausa, painel, chat e "ainda não começou" de uma vez.
  // Sem isto, clicar no fundo escurecido do menu de pausa disparava o blaster.
  if (cursorLivre() || mode !== 'FOOT') return;

  if (event.button === 0) botao.esquerdo = true;
  if (event.button === 2) botao.direito = true;

  // Construir é instantâneo: dispara no clique, não enquanto segura. Segurar
  // encheria a base de peças a 60 por segundo.
  if (ferramentaAtual().id === 'construtor') {
    if (event.button === 0) construir();
    else if (event.button === 2) demolir();
  }
});

window.addEventListener('mouseup', (event) => {
  arrastando = false;
  deslizando = false;
  if (event.button === 0) botao.esquerdo = false;
  if (event.button === 2) botao.direito = false;
  if (!botao.esquerdo && !botao.direito) terraform.soltar();
});

/** Coordenadas normalizadas do evento, para o raycast do mapa. */
function escolherNoMapa(event) {
  const r = canvas.getBoundingClientRect();
  return galaxyMap.escolherEm(
    ((event.clientX - r.left) / r.width) * 2 - 1,
    -((event.clientY - r.top) / r.height) * 2 + 1
  );
}

canvas.addEventListener('mousemove', (event) => {
  if (!galaxyMap.aberto) return;

  // -------------------------------------------------------------------------
  // O ESTADO DE ARRASTO É RECONFERIDO PELO PRÓPRIO EVENTO.
  //
  // `event.buttons` diz quais botões estão pressionados AGORA. A flag sozinha
  // não bastava: basta um `mouseup` perdido — soltar o botão fora da janela,
  // trocar de aba no meio do arrasto, um menu do sistema roubando o foco — para
  // ela ficar presa em `true`. E `true` aqui significa "o cursor está girando a
  // câmera", ou seja, o hover para de rodar e o mapa fica TRAVADO na última
  // estrela escolhida, sem nenhuma pista do que aconteceu.
  // -------------------------------------------------------------------------
  if ((event.buttons & 1) === 0) arrastando = false;
  if ((event.buttons & 2) === 0) deslizando = false;

  if (arrastando) galaxyMap.orbitar(event.movementX, event.movementY);
  else if (deslizando) galaxyMap.deslocar(event.movementX, event.movementY);
  else {
    const antes = galaxyMap.selecionado;
    const alvo = escolherNoMapa(event);
    // Um blip só quando o cursor ENTRA numa estrela nova. Sem a comparação, o
    // som dispararia a cada frame do movimento sobre a mesma estrela.
    if (alvo && alvo !== antes) audio.ui(true);
  }
});

canvas.addEventListener('dblclick', (event) => {
  if (!galaxyMap.aberto) return;
  // Duplo clique numa estrela salta para ela — o gesto que todo mapa usa para
  // "ir até aqui", e que evita procurar a tecla certa no meio da navegação.
  if (escolherNoMapa(event)) saltarPara(galaxyMap.selecionado);
});

// Sem isto, o botão direito abre o menu do navegador por cima do jogo — e o
// pointer lock é perdido junto.
canvas.addEventListener('contextmenu', (event) => {
  // No mapa o botão direito arrasta o campo de estrelas; sem isto, cada arrasto
  // termina com o menu do navegador aberto por cima da galáxia.
  if (galaxyMap.aberto || (started && mode === 'FOOT')) event.preventDefault();
});

canvas.addEventListener(
  'wheel',
  (event) => {
    if (galaxyMap.aberto) {
      event.preventDefault();
      galaxyMap.aproximar(event.deltaY);
      return;
    }
    if (mode !== 'FOOT' || !started) return;
    event.preventDefault();
    // Sempre equipamento. Fazer a roda mudar de sentido conforme a ferramenta
    // na mão parecia esperto e era a mesma armadilha de sempre: um controle com
    // dois significados obriga a pessoa a lembrar em que estado está antes de
    // usá-lo. A peça de construção anda em `Q` e `E`.
    equipar(ferramenta + (event.deltaY > 0 ? 1 : -1));
  },
  { passive: false }
);

function construir() {
  const resultado = build.colocar();
  if (!resultado.ok) {
    hud.notify(resultado.erro.toUpperCase(), 1.4);
    audio.ui(false);
    return;
  }
  audio.build();
  viewModel.coice(0.8);
  multiplayer?.construiu(resultado.evento);
}

function demolir() {
  const resultado = build.remover();
  if (!resultado.ok) {
    hud.notify(resultado.erro.toUpperCase(), 1.4);
    return;
  }
  audio.demolish();
  viewModel.coice(0.5);
  hud.notify(`${resultado.nome.toUpperCase()} RECUPERADO`, 1.4);
  multiplayer?.construiu(resultado.evento);
}

/* ========================================================================== */
/* Abrir e fechar o mapa                                                      */
/* ========================================================================== */

function alternarMapa() {
  if (galaxyMap.aberto) {
    fecharMapa();
    return;
  }

  // O mapa é um instrumento de bordo: só faz sentido com a nave no espaço.
  // Aberto a pé, ele mostraria um destino que o jogador não tem como alcançar.
  if (warp.ativo) return;
  if (mode !== 'SHIP') {
    hud.notify('EMBARQUE NA NAVE PARA ABRIR O MAPA', 2.2);
    audio.ui(false);
    return;
  }

  alternarPainel(false);
  galaxyMap.aberto = true;
  galaxyMap.redimensionar(window.innerWidth / window.innerHeight);
  galaxyMap.centralizarNoAtual();
  // Sem deslize na abertura: o mapa já nasce enquadrado no sistema atual. O
  // amortecimento existe para os movimentos que o jogador COMANDA — animar
  // também a entrada só atrasaria a primeira leitura da tela.
  galaxyMap.assentar();
  hud.mostrarMapa(true);
  soltarPonteiro();

  // ---------------------------------------------------------------------
  // O MUNDO PARA ENQUANTO O MAPA ESTÁ ABERTO.
  //
  // Antes o jogo continuava rodando por baixo: a nave seguia em voo livre
  // (com o acelerador exatamente como foi deixado), a geração de terreno
  // continuava consumindo CPU e o motor continuava roncando sobre uma tela
  // onde não há nave nenhuma. Nada disso é observável durante o mapa — a
  // cena do mundo sequer é desenhada —, então tudo o que sobrava era o
  // custo, e a surpresa desagradável de fechar o mapa noutro lugar.
  //
  // O motor é silenciado explicitamente porque as camadas contínuas do
  // áudio são osciladores que nunca param: sem zerar o ganho, apenas deixar
  // de atualizá-los congela o último som tocando para sempre.
  // ---------------------------------------------------------------------
  shipController.throttle = 0;
  audio.silenciarContinuos();
  audio.ui(true);
}

function fecharMapa() {
  if (!galaxyMap.aberto) return;
  galaxyMap.aberto = false;
  galaxyMap.eixos.frente = galaxyMap.eixos.lado = galaxyMap.eixos.cima = 0;
  hud.mostrarMapa(false);
  audio.ui(false);
  requestPointerLock();
}

/* ========================================================================== */
/* Descoberta de sistemas                                                     */
/* ========================================================================== */

/** Endereço já reivindicado — evita remandar o pedido a cada frame. */
let sistemaReivindicado = null;

/**
 * Reivindica o sistema atual para quem está pilotando, se ele não tiver dono.
 *
 * ---------------------------------------------------------------------------
 * POR QUE ISTO VIVE NO LAÇO E NÃO NA CHEGADA
 * ---------------------------------------------------------------------------
 * A tentação é chamar isto uma vez, logo depois de `situar`. Não funciona, e a
 * falha é silenciosa: no boot, o jogo entra no sistema ANTES de a sala
 * responder, então a reivindicação sairia sem o catálogo em mãos — e o cliente
 * marcaria como inédito um sistema que outra pessoa descobriu no mês passado.
 * Esperar a conexão numa chamada única traria o problema oposto: quem joga sem
 * servidor nunca registraria nada.
 *
 * Uma tentativa por frame, guardada por um endereço já resolvido, cobre os dois
 * casos sem nenhuma coordenação: assim que houver resposta (ou a certeza de que
 * não há sala), o registro acontece. O custo é uma busca em `Map` por frame, e
 * só enquanto o sistema atual ainda não foi resolvido.
 */
function tentarReivindicarSistema() {
  const sistema = galaxyMap.atual;
  if (!sistema) return;

  const endereco = galaxyMap.chaveDe(sistema);
  if (sistemaReivindicado === endereco) return;

  // Já tem dono: nada a reivindicar, e o assunto se encerra para este sistema.
  if (galaxyMap.descobertas.has(endereco)) {
    sistemaReivindicado = endereco;
    return;
  }

  // Ainda negociando com a sala: o catálogo pode estar a caminho.
  if (multiplayer && multiplayer.estado === 'conectando') return;

  const nome = nomeDoSistema(sistema);
  sistemaReivindicado = endereco;

  if (multiplayer?.conectado) {
    // Quem decide é o servidor. A marca no mapa só aparece quando a
    // confirmação volta — inclusive a recusa, que chega como a descoberta de
    // outra pessoa.
    multiplayer.descobriu(endereco, nome);
    return;
  }

  // Sem sala: o registro é local e o crédito é de quem está jogando.
  if (galaxyMap.registrarDescoberta({ endereco, nome, descobridor: nomeDoPiloto(), quando: new Date().toISOString() })) {
    hud.notify(`SISTEMA INÉDITO: ${nome.toUpperCase()} É SEU`, 3.4);
  }
}

/* ========================================================================== */
/* Salto interestelar                                                         */
/* ========================================================================== */

/** Chunks que o sistema novo precisa entregar antes de a viagem terminar. */
const CHUNKS_PARA_CHEGAR = 24;

/**
 * Onde a nave nasce ao chegar num sistema: fora da atmosfera do corpo inicial,
 * olhando para ele. Chegar dentro do planeta seria o resultado de simplesmente
 * manter a posição anterior — que no sistema novo significa outro lugar.
 */
const _alvoChegada = new THREE.Vector3();

function posicionarNaChegada() {
  const destino = starSystem.planets[0];
  const radial = new THREE.Vector3(0.35, 0.42, 1).normalize();
  ship.group.position
    .copy(destino.group.position)
    .addScaledVector(radial, destino.radius * 3.2);

  // ---------------------------------------------------------------------------
  // A ATITUDE DA CHEGADA É MONTADA À MÃO.
  //
  // Antes era `orientTowards(nave, centro do planeta)`, e isso põe o nariz
  // apontado EXATAMENTE para o centro — a nave materializa mergulhando. Pior: a
  // referência de rolagem era o Y do MUNDO, que não tem relação nenhuma com o
  // planeta à frente, então a nave chegava girada em relação ao horizonte que o
  // jogador está vendo. Os dois efeitos juntos são o que se lê como "entrar de
  // cabeça para baixo".
  //
  // A montagem abaixo dá as duas coisas que faltavam: o planeta ADIANTE e
  // ABAIXO (não sob os pés), e um "para cima" que é o radial do ponto de
  // chegada — o mesmo que o jogador vai usar como referência ao descer.
  // ---------------------------------------------------------------------------
  const lado = new THREE.Vector3().crossVectors(radial, new THREE.Vector3(0, 1, 0));
  // Radial paralelo ao Y do mundo deixaria o produto vetorial nulo e a base
  // inteira degenerada. Não acontece com a constante atual, mas o dia em que
  // alguém mudar o vetor de chegada não deveria ser um dia de depuração.
  if (lado.lengthSq() < 1e-6) lado.crossVectors(radial, new THREE.Vector3(1, 0, 0));
  lado.normalize();

  const tangente = new THREE.Vector3().crossVectors(lado, radial).normalize();
  // 0.85 do radial contra 1 da tangente: cerca de 40° de mergulho. O planeta
  // ocupa a metade de baixo do quadro, que é o enquadramento de chegada.
  const nariz = tangente.clone().addScaledVector(radial, -0.85).normalize();
  const cima = radial.clone().addScaledVector(nariz, -radial.dot(nariz)).normalize();

  orientTowards(ship.group, _alvoChegada.copy(ship.group.position).add(nariz), cima);

  shipController.velocity.set(0, 0, 0);
  shipController.throttle = 0;
  playerController.enabled = false;
  mode = 'SHIP';
  activePlanet = destino;

  // A câmera é teletransportada junto. Ver `ShipController.assentarCamera`.
  shipController.assentarCamera(engine.camera);
}

/** O salto é permitido? Devolve o motivo quando não. */
function motivoParaNaoSaltar(sistema) {
  if (warp.ativo) return 'salto em andamento';
  if (mode !== 'SHIP') return 'embarque na nave';
  if (!sistema) return 'nenhum sistema selecionado';
  if (galaxyMap.atual && sistema.seed === galaxyMap.atual.seed) return 'você já está aqui';
  if (gameState.atmosphere > 0.02) return 'saia da atmosfera';
  if (!galaxyMap.podeSaltar(sistema)) return 'fora do alcance do hiperimpulsor';
  return null;
}

function saltarPara(sistema) {
  const impedimento = motivoParaNaoSaltar(sistema);
  if (impedimento) {
    hud.notify(impedimento.toUpperCase(), 2.2);
    audio.ui(false);
    return false;
  }

  audio.pulseEngage();
  fecharMapa();

  warp.iniciar({
    cor: sistema.classe.cor,
    /**
     * Troca o universo no auge do clarão.
     *
     * `recriar` destrói planetas e workers e constrói outros no lugar, mantendo
     * o mesmo objeto `StarSystem` — quem guardou a referência (multijogador,
     * construção) continua válido. O que guardou PLANETAS precisa se
     * reinscrever, e é o que as três chamadas seguintes fazem.
     */
    aoTrocar: () => {
      starSystem.recriar(sistema.seed);
      // A direcional do sistema novo é outro objeto: sem reinscrever, as
      // sombras continuariam presas à luz da estrela que acabou de ser
      // descartada — e simplesmente sumiriam da cena.
      sombras.adotar(starSystem.sunLight);
      // O alerta é de um SISTEMA, não do jogador: fugir num salto é uma saída
      // legítima e cara (custa combustível de dobra), e mantê-lo pelo universo
      // afora deixaria o jogador perseguido para sempre pelo que fez uma vez.
      sentinelas.limpar();
      projeteis.limpar();
      inscreverNaOrigemFlutuante();
      posicionarNaChegada();

      // Bases e escavações pertencem ao sistema onde foram feitas. Sem esta
      // limpeza, a base construída na estrela anterior reapareceria flutuando
      // sobre um planeta que nada tem a ver com ela.
      build.esquecerTudo();

      // TROCA DE CANAL. Precisa acontecer antes de o primeiro pacote de posição
      // sair daqui: um `state` enviado com o universo novo e o canal antigo
      // poria este avatar dentro do planeta de quem ficou para trás. O servidor
      // responde com o mundo do sistema de destino — bases, colheitas,
      // escavações e quem já está lá.
      multiplayer?.mudarSistema(sistema.seed);

      galaxiaAtual = sistema.galaxia;
      galaxyMap.situar(sistema.galaxia, sistema.seed, { x: sistema.vx, y: sistema.vy, z: sistema.vz });
      hud.notify(`SISTEMA ${nomeDoSistema(sistema).toUpperCase()}`, 3.2);
      // Sistema novo, reivindicação nova. Sem isto, o endereço resolvido do
      // sistema anterior continuaria valendo e a chegada nunca seria registrada.
      sistemaReivindicado = null;
      if (contaAtiva) salvarProgresso();
    },
    // A viagem só termina quando há terreno para chegar em cima. Ver o
    // cabeçalho de `galaxy/WarpJump.js`.
    pronto: () => starSystem.isReady && starSystem.activeChunks >= CHUNKS_PARA_CHEGAR,
  });
  return true;
}

/* ========================================================================== */
/* Painel de inventário e catálogo                                            */
/* ========================================================================== */

let painelAberto = false;

function alternarPainel(aberto) {
  painelAberto = aberto ?? !painelAberto;
  hud.mostrarPainel(painelAberto);
  audio.ui(painelAberto);

  if (painelAberto) {
    // Solta o cursor: o painel é clicável, e com o ponteiro travado no canvas
    // não haveria como escolher uma peça.
    soltarPonteiro();
  } else if (started) {
    requestPointerLock();
  }
}

/** Escolher uma peça no catálogo já equipa o construtor e fecha o painel. */
function escolherPecaDoCatalogo(indice) {
  build.selecionarIndice(indice);
  equipar(FERRAMENTAS.findIndex((f) => f.id === 'construtor'));
  alternarPainel(false);
}

function runScan() {
  playerController.getEyePosition(_eye);
  audio.scan();
  const resultado = scanner.scan(_eye, activePlanet, discovery, inventory);

  if (resultado.novas.length > 0) {
    audio.discovery();
    // Fauna primeiro quando houver: é a descoberta mais rara e a que o jogador
    // menos espera ver, então é ela que merece o cartão na tela.
    const primeira = resultado.novas.find((n) => n.categoria.startsWith('Fauna')) ?? resultado.novas[0];
    hud.showDiscovery(primeira.nome, primeira.categoria + ' · ' + activePlanet.name, resultado.unidades);
  } else if (resultado.flora + resultado.fauna > 0) {
    hud.notify(`${resultado.flora} FLORA · ${resultado.fauna} FAUNA NO RAIO`, 2.2);
  } else {
    hud.notify('NENHUM SINAL', 2.2);
  }
}

/** Acumulador do som do terraformador — uma pá de terra a cada intervalo. */
let terraTimer = 0;
/** Conta regressiva até o próximo pacote de escavação para a sala. */
let terraRede = 0;

/**
 * Despacha a mira e a ação para a ferramenta equipada.
 *
 * Um `switch` num lugar só, e não uma flag por sistema. Cada ferramenta apaga
 * explicitamente o que as outras deixaram na tela (feixe, fantasma, anel) —
 * esquecer isso é como o fantasma da construção ficava pendurado no ar depois
 * de embarcar na nave.
 */
function updateTools(dt) {
  const equipado = ferramentaAtual();
  const ativoAPe = mode === 'FOOT' && started && !painelAberto;

  if (!ativoAPe) {
    scanner.updateBeam(null, null);
    scanner.target = null;
    build.mirar(_eye, _lookDir, activePlanet); // inativo: só esconde o fantasma
    terraform.mirar(_eye, _lookDir, activePlanet, false);
    return;
  }

  playerController.getEyePosition(_eye);
  playerController.getLookDirection(_lookDir);

  const planetaId = starSystem.planets.indexOf(activePlanet);

  // --- Construtor ---------------------------------------------------------
  if (equipado.id === 'construtor') {
    scanner.updateBeam(null, null);
    scanner.target = null;
    terraform.mirar(_eye, _lookDir, activePlanet, false);
    build.mirar(_eye, _lookDir, activePlanet);
    return;
  }

  build.mirar(_eye, _lookDir, activePlanet); // `ativo` falso: esconde o fantasma

  // --- Blaster ------------------------------------------------------------
  if (equipado.id === 'blaster') {
    scanner.updateBeam(null, null);
    scanner.target = null;
    terraform.mirar(_eye, _lookDir, activePlanet, false);

    if (botao.esquerdo && blaster.primario(_eye, _lookDir, jogadorComoDono)) {
      viewModel.coice(0.5);
      audio.terraform(true);
    }
    if (botao.direito && blaster.secundario(_eye, _lookDir, jogadorComoDono)) {
      viewModel.coice(1.0);
      audio.terraform(false);
    }
    return;
  }

  // --- Terraformador ------------------------------------------------------
  if (equipado.id === 'terraformador') {
    scanner.updateBeam(null, null);
    scanner.target = null;
    terraform.mirar(_eye, _lookDir, activePlanet, true);

    const sentido = botao.esquerdo ? -1 : botao.direito ? 1 : 0;
    if (sentido !== 0) {
      const resultado = terraform.esculpir(dt, sentido);

      terraTimer -= dt;
      if (terraTimer <= 0) {
        terraTimer = 0.13;
        audio.terraform(sentido < 0);
        viewModel.coice(0.35);
      }

      // A rede recebe a MESMA edição repetidamente, com a profundidade
      // crescendo. 8 Hz basta: quem está do outro lado vê o buraco se
      // aprofundar, e um pacote perdido se corrige no envio seguinte.
      terraRede -= dt;
      if (resultado && terraRede <= 0) {
        terraRede = 0.125;
        multiplayer?.terraformou(resultado.planeta, resultado.edicao);
      }
    } else {
      terraform.soltar();
      terraTimer = 0;
    }
    return;
  }

  // --- Multiferramenta ----------------------------------------------------
  terraform.mirar(_eye, _lookDir, activePlanet, false);
  const target = scanner.aim(_eye, _lookDir, activePlanet);

  if (botao.esquerdo && target) {
    scanner.updateBeam(_eye, target.position);
    viewModel.coice(dt * 3.5);
    // O alvo precisa ser lido ANTES de minerar: `scanner.mine()` zera o alvo
    // quando o prop acaba, e é justamente esse o que a sala precisa saber.
    const alvo = scanner.target;
    const colheita = scanner.mine(dt, activePlanet, inventory);
    if (colheita && alvo) {
      multiplayer?.colheu(planetaId, alvo.key, alvo.index);
    }
    if (colheita) {
      // Extrair chama a atenção, mas pouco: o peso é dez vezes menor que o de
      // abater uma criatura, então minerar um depósito inteiro custa menos de
      // meio nível. Punir a atividade central do jogo seria o erro óbvio aqui.
      if (!colheita.cheio) sentinelas.registrarInfracao(0.05);
      if (colheita.cheio) hud.notify('CARGA CHEIA', 1.8);
      else {
        audio.collect();
        hud.notify(`+${colheita.quantidade} ${colheita.nome.toUpperCase()}`, 1.4);
      }
    }
  } else {
    scanner.updateBeam(null, null);
  }
}

/* ========================================================================== */
/* Descoberta de planetas                                                     */
/* ========================================================================== */

function checkPlanetDiscovery(planet, altitude) {
  // Registrado ao ENTRAR na atmosfera: é o momento em que o jogador de fato
  // chegou, e não apenas apontou a nave na direção certa.
  if (altitude > planet.config.atmosphere.height) return;
  const resultado = discovery.registerPlanet(planet);
  if (resultado.novo) {
    audio.discovery();
    inventory.units += resultado.unidades;
    hud.showDiscovery(resultado.nome, `Planeta ${planet.config.type}`, resultado.unidades);
  }
}

/* ========================================================================== */
/* Marcadores                                                                 */
/* ========================================================================== */

const markerList = [];

function buildMarkers(referencePosition) {
  markerList.length = 0;

  // Os outros jogadores entram em QUALQUER modo, e antes de tudo: encontrar
  // alguém é o objetivo mais urgente que existe num mundo deste tamanho, e um
  // marcador na tela é a única forma prática de conseguir isso.
  if (multiplayer) {
    for (const jogador of multiplayer.listar(referencePosition, activePlanet)) {
      // Sem `posicao` não há para onde apontar — o painel já mostra que a
      // pessoa está na sala; o marcador aparece quando ela se localiza.
      if (jogador.eu || !jogador.posicao) continue;
      markerList.push({
        id: `player-${jogador.id}`,
        position: jogador.posicao,
        label: jogador.nome.toUpperCase(),
        sub: jogador.local,
        kind: 'player',
      });
    }
  }

  if (mode === 'FOOT') {
    // A única coisa que importa a pé: onde ficou a nave.
    const distance = playerController.position.distanceTo(ship.group.position);
    markerList.push({
      id: 'ship',
      position: ship.group.position,
      label: 'NAVE',
      sub: `${distance.toFixed(0)} m`,
      kind: 'ship',
    });
    return markerList;
  }

  // Em voo: todos os corpos do sistema, para escolher destino sem abrir mapa.
  for (const planet of starSystem.planets) {
    if (planet === activePlanet && gameState.atmosphere > 0.15) continue;
    const distance = referencePosition.distanceTo(planet.group.position) - planet.radius;
    markerList.push({
      id: `planet-${planet.planetId}`,
      position: planet.group.position,
      label: planet.name.toUpperCase(),
      sub: formatRange(distance),
      kind: planet.isMoon ? 'moon' : 'planet',
    });
  }
  return markerList;
}

const NOME_DO_RECURSO = new Map(RESOURCES.map((r) => [r.id, r.nome]));
const nomeDoRecurso = (id) => NOME_DO_RECURSO.get(id) ?? id;

function formatRange(value) {
  if (value < 0) return 'superfície';
  if (value > 1000) return `${(value / 1000).toFixed(1)} km`;
  return `${value.toFixed(0)} m`;
}

/* ========================================================================== */
/* Transições                                                                 */
/* ========================================================================== */

gameState.onPhaseChange = (phase, previous) => {
  if (!started) return;

  if (phase === Phase.ATMOSPHERE && previous === Phase.SPACE) {
    audio.reentry();
    hud.notify('ENTRADA ATMOSFÉRICA');
  } else if (phase === Phase.SPACE && previous === Phase.ATMOSPHERE) {
    hud.notify('ÓRBITA ALCANÇADA');
  } else if (phase === Phase.SURFACE && previous === Phase.ATMOSPHERE) {
    hud.notify('APROXIMAÇÃO FINAL');
  } else if (phase === Phase.LANDED && mode === 'SHIP') {
    // O peso do pouso vem da velocidade com que se chegou — tocar sempre o
    // mesmo baque faz encostar de leve soar igual a espatifar.
    audio.land(shipController.speed / 120);
  }
};

/* ========================================================================== */
/* Loop                                                                       */
/* ========================================================================== */

const _reference = new THREE.Vector3();
/** Último planeta cuja fauna recebeu update — ver o passo 7. */
let faunaPlanet = null;
let biomeLabel = '—';
/** Estado do pulse no frame anterior, para disparar o som só na TRANSIÇÃO. */
let wasPulsing = false;
/** Conta regressiva até a próxima gravação de progresso, em segundos. */
let salvarTimer = 20;

/* ========================================================================== */
/* Onde o jogador parou                                                       */
/* ========================================================================== */

const _salvarLocal = new THREE.Vector3();

/**
 * Fotografia da posição, para voltar exatamente onde se saiu.
 *
 * ---------------------------------------------------------------------------
 * COORDENADAS RELATIVAS AO PLANETA, NUNCA DE MUNDO
 * ---------------------------------------------------------------------------
 * Pelo mesmo motivo que a rede usa espaço local (ver `net/Multiplayer.js`): a
 * origem flutuante desloca a cena inteira conforme o jogador anda, então a
 * mesma coordenada de cena significa lugares diferentes em duas sessões. O
 * centro do planeta é o único referencial que sobrevive a um recarregamento —
 * e ele próprio deriva do seed, que é fixo.
 *
 * ---------------------------------------------------------------------------
 * A NAVE VAI JUNTO, SEMPRE
 * ---------------------------------------------------------------------------
 * Guardar só o jogador funciona enquanto ele estiver pilotando. Quem sai do
 * jogo a pé, a duzentos metros da nave, voltaria com ela de volta ao ponto
 * inicial do sistema — ou seja, a pé e sem transporte, num planeta qualquer.
 * A nave estacionada é parte de onde você parou.
 */
function estadoDePosicao() {
  const planetaId = starSystem.planets.indexOf(activePlanet);
  if (planetaId < 0) return null;

  const centro = activePlanet.group.position;
  const local = (v) => _salvarLocal.copy(v).sub(centro).toArray();

  const estado = {
    planeta: planetaId,
    modo: mode,
    // O sistema entra junto porque ele DEFINE o mundo: sem ele, restaurar a
    // posição devolveria coordenadas certas num universo errado — o jogador
    // apareceria no vácuo, ou dentro de um planeta que só existe aqui.
    galaxia: galaxiaAtual,
    sistema: starSystem.seed,
    visitados: galaxyMap.visitadosParaLista(),
    nave: {
      pos: local(ship.group.position),
      quat: ship.group.quaternion.toArray(),
    },
  };

  if (mode === 'FOOT') {
    estado.jogador = local(playerController.position);
    // O olhar entra para não devolver a pessoa girada para um lado aleatório —
    // reencontrar a nave depois de carregar já é trabalho suficiente.
    estado.olhar = playerController.forward.toArray();
    estado.pitch = playerController.pitch;
  }

  return estado;
}

/**
 * Recoloca o jogador onde parou.
 *
 * Chamado depois da autenticação, quando o terreno inicial já está pronto (o
 * botão de iniciar só libera aí). Se o ponto salvo estiver em outro corpo, a
 * malha de lá ainda não existe — e isso é seguro: colisão e altitude usam o
 * amostrador analítico (`planet.sampleAt`), que responde certo mesmo onde
 * nenhum chunk chegou. O terreno aparece em volta nos segundos seguintes.
 *
 * @returns {boolean} restaurou de fato
 */
function restaurarPosicao(estado) {
  if (!estado || typeof estado.planeta !== 'number') return false;

  galaxyMap.restaurarVisitados(estado.visitados);

  // O universo vem ANTES da posição. Reconstruir depois de colocar o jogador
  // destruiria os planetas debaixo dele e o deixaria caindo no vazio.
  if (typeof estado.sistema === 'number' && estado.sistema !== starSystem.seed) {
    starSystem.recriar(estado.sistema);
    sombras.adotar(starSystem.sunLight);
    inscreverNaOrigemFlutuante();
    build.esquecerTudo();
  }
  galaxiaAtual = estado.galaxia ?? 0;
  galaxyMap.situar(galaxiaAtual, starSystem.seed);

  const planeta = starSystem.planets[estado.planeta];
  if (!planeta) return false;

  const centro = planeta.group.position;
  const mundo = (arr) => new THREE.Vector3().fromArray(arr).add(centro);

  if (estado.nave?.pos) {
    ship.group.position.copy(mundo(estado.nave.pos));
    if (estado.nave.quat) ship.group.quaternion.fromArray(estado.nave.quat);
  }

  // Zera a física: velocidade guardada de outra sessão faria a nave sair
  // deslizando sozinha no primeiro frame.
  shipController.velocity.set(0, 0, 0);
  shipController.throttle = 0;

  activePlanet = planeta;

  if (estado.modo === 'FOOT' && estado.jogador) {
    const olhar = estado.olhar
      ? new THREE.Vector3().fromArray(estado.olhar)
      : new THREE.Vector3(0, 0, -1);
    // `spawnAt` reprojeta o olhar no plano tangente e assenta o jogador na
    // superfície — inclusive se o terreno mudou de altura desde que ele saiu,
    // por escavação de outro jogador.
    playerController.spawnAt(mundo(estado.jogador), planeta, olhar);
    playerController.pitch = estado.pitch ?? 0;
    playerController.enabled = true;
    mode = 'FOOT';
  } else {
    playerController.enabled = false;
    mode = 'SHIP';
  }

  return true;
}

function salvarProgresso() {
  multiplayer?.salvarProgresso({
    unidades: inventory.units,
    inventario: inventory.toJSON(),
    descobertas: discovery.toJSON(),
    posicao: estadoDePosicao(),
  });
}

// Fechar a aba é a saída mais comum — e a que perderia mais progresso.
window.addEventListener('beforeunload', () => {
  if (contaAtiva) salvarProgresso();
});
let biomeTimer = 0;
const BIOME_INTERVAL = 0.25;

engine.start((dt, elapsed) => {
  // 0.0 Pausa: nada avança, mas o quadro continua sendo desenhado -----------
  //
  // Desenhar é justamente o ponto: o menu tem opções gráficas, e o jogador
  // precisa VER o efeito de cada uma sobre a cena real atrás do vidro fosco.
  // Um menu sobre tela preta obrigaria a fechar, olhar, reabrir e adivinhar.
  //
  // O `return` cobre física, LOD, fauna, sentinelas e rede — que é o que
  // "pausado" tem de significar.
  if (menuPausa.aberto) return;

  // 0. Mapa galáctico: o mundo fica congelado ------------------------------
  //
  // O mapa não é uma sobreposição, é um MODO. A cena do mundo nem chega a ser
  // desenhada (ver `Engine.render`), então tudo o que o resto deste laço faria
  // — física, LOD, geração de terreno, fauna, áudio — seria trabalho invisível.
  // Pior que invisível: a nave continuava voando, e fechar o mapa devolvia o
  // jogador a um lugar diferente daquele de onde ele saiu.
  //
  // O salto é a única coisa que precisa continuar rodando, porque ele começa
  // com o mapa ainda aberto e é ele que o fecha.
  if (galaxyMap.aberto) {
    galaxyMap.atualizar(dt);
    warp.atualizar(dt);
    hud.atualizarMapa({
      ficha: galaxyMap.fichaSelecionada(),
      galaxia: GALAXIAS[galaxyMap.galaxia]?.nome ?? '—',
      visitados: galaxyMap.visitados.size,
      alcance: ALCANCE_SALTO,
      estrelas: galaxyMap._lista.length,
    });
    return;
  }

  // 1. Sol deste frame (dia/noite) ---------------------------------------
  starSystem.updateBackdrop(engine.camera, elapsed, gameState.atmosphere);

  // 2. Quem manda agora: o corpo cuja superfície está mais perto ----------
  _reference.copy(mode === 'FOOT' ? playerController.position : ship.group.position);
  activePlanet = starSystem.nearestPlanet(_reference);

  // 3. Física --------------------------------------------------------------
  if (started) {
    if (mode === 'FOOT') {
      playerController.update(dt, activePlanet);
      // Depois do terreno, nunca antes: o controlador resolve a esfera e só
      // então as caixas da base corrigem o que sobrou. Ver `resolverColisao`.
      build.resolverColisao(playerController);
    } else shipController.update(dt, activePlanet, gameState.atmosphere);
  }
  _reference.copy(mode === 'FOOT' ? playerController.position : ship.group.position);

  // 4. Ambiente (névoa, luz, exposição) em função da nova altitude ---------
  const landed = mode === 'FOOT' ? playerController.grounded : shipController.landed;
  gameState.update(activePlanet, _reference, landed);

  // Os DOIS avançam todo quadro, inclusive o que não está em uso: o escudo da
  // nave deixada no chão precisa se recuperar enquanto o piloto explora a pé,
  // senão voltar para ela depois de um combate significaria decolar sem escudo
  // nenhum, sem nada na tela explicando por quê.
  if (started) {
    vitaisJogador.atualizar(dt);
    vitaisNave.atualizar(dt);
    blaster.atualizar(dt);
    // As sentinelas ANTES dos projéteis: elas se movem e atiram, e o tiro
    // disparado neste quadro deve andar no mesmo quadro. Invertido, todo tiro
    // de drone ficaria um quadro parado na boca.
    sentinelas.atualizar(
      dt,
      activePlanet,
      mode === 'FOOT' ? playerController.position : ship.group.position,
      jogadorComoDono,
      gameState.altitude < 400
    );
    // Os tiros avançam DEPOIS da física e ANTES da câmera: assim o impacto é
    // resolvido contra as posições deste quadro, e não contra as do anterior.
    projeteis.atualizar(dt, activePlanet, montarAlvos());
  }

  if (started) checkPlanetDiscovery(activePlanet, gameState.altitude);

  // 5. Câmera --------------------------------------------------------------
  if (mode === 'FOOT') playerController.updateCamera(engine.camera);
  else shipController.updateCamera(engine.camera, dt);
  engine.tuneCameraPlanes(Math.max(gameState.altitude, 1));

  // 5.1 Origem flutuante -----------------------------------------------------
  // DEPOIS da câmera e ANTES do LOD, e as duas coisas importam. Depois da
  // câmera porque é a posição dela deste frame que define o deslocamento;
  // antes do LOD porque a quadtree subdivide em torno da câmera, e rodar com
  // as posições antigas geraria chunks no lugar errado por um frame.
  //
  // A física já rodou com as coordenadas anteriores, e isso é indiferente:
  // todo mundo andou o mesmo tanto, então velocidade, distância e altitude são
  // exatamente as mesmas. Só o `_reference` precisa ser relido.
  if (floatingOrigin.update(engine.camera)) {
    _reference.copy(mode === 'FOOT' ? playerController.position : ship.group.position);
  }

  // 5.2 Perspectiva aérea ----------------------------------------------------
  // Depois do rebase, porque o centro do planeta que vai para o shader é uma
  // posição de CENA — se fosse lida antes, a atmosfera sobre o terreno ficaria
  // deslocada por um frame a cada recentragem.
  if (engine.aerialEnabled) {
    engine.aerial.setPlanet(
      activePlanet.config,
      activePlanet.group.position,
      starSystem.sunDirection,
      engine.camera.position.distanceTo(activePlanet.group.position)
    );
  }

  // 5.3 Sombras --------------------------------------------------------------
  // Depois do rebase e da câmera, pelo mesmo motivo da perspectiva aérea: a
  // caixa de sombra é posicionada em coordenadas de CENA e um frame de atraso a
  // deixaria deslocada exatamente pelo tamanho do salto de recentragem — o que
  // se veria como a sombra inteira escorregando no chão a cada rebase.
  sombras.atualizar(engine.camera, starSystem.sunDirection, gameState.altitude, gameState.up);
  ceuAmbiente.atualizar(activePlanet.config, gameState, starSystem.sunDirection, gameState.up, dt);

  // 6. LOD + fila de geração ----------------------------------------------
  // A qualidade das nuvens vem ANTES do LOD dos planetas porque é lá que ela
  // é lida. Só conta depois do boot: os primeiros frames incluem compilação
  // de shader e a primeira leva de chunks, e derrubariam o nível por engano.
  if (started) cloudQuality.update(engine.fps, dt);
  starSystem.updatePlanets(engine.camera.position, activePlanet, elapsed);

  // O vento é um uniforme só, compartilhado por todos os materiais de
  // vegetação — daí bastar esta linha por frame. Ver `shaders/WindShader.js`.
  windTime.value = elapsed;

  // 7. Fauna, ferramentas e efeitos ---------------------------------------
  // A fauna vem depois da câmera e do LOD porque só existe perto do chão: se
  // atualizasse antes, gastaria tempo em planetas que sequer serão vistos.
  // Só o planeta ativo tem criaturas — as dos outros já foram esvaziadas pela
  // própria checagem de altitude quando o jogador se afastou.
  if (faunaPlanet && faunaPlanet !== activePlanet) faunaPlanet.fauna.despawnAll();
  faunaPlanet = activePlanet;
  if (started) {
    // O fator dia decide quais espécies podem nascer: as noturnas só saem com o
    // sol abaixo do horizonte (ver `Fauna.update`).
    activePlanet.fauna.update(dt, _reference, gameState.altitude, gameState.dayFactor);
    ligarAtaquesDaFauna(activePlanet);
  }

  // O clima vem depois da câmera e do rebase: as partículas vivem num grupo
  // ancorado na posição de CENA da câmera deste frame, e usá-la antes do
  // rebase deixaria a chuva um passo atrás a cada recentragem.
  weather.update(dt, activePlanet, _reference, engine.camera.position);
  gameState.nevoaExtra = weather.nevoaExtra;
  // Só a pé: dentro da nave a cabine é seca (e a nave não mergulha).
  gameState.submerso = mode === 'FOOT' ? playerController.submerso : 0;

  updateTools(dt);
  scanner.updatePulse(dt);
  // Platôs pendentes e animação de surgimento das peças. Fora do `updateTools`
  // de propósito: a base continua crescendo e assentando o terreno mesmo com o
  // construtor guardado, porque outro jogador pode estar construindo nela.
  build.atualizar(dt);

  warp.atualizar(dt);

  viewModel.atualizar(dt, {
    visivel: started && mode === 'FOOT' && !painelAberto && !warp.ativo,
    // A cena de sobreposição precisa continuar sendo desenhada durante o salto:
    // é nela que o túnel vive.
    cenaAtiva: warp.ativo,
    velocidade: playerController.speed,
    usando: botao.esquerdo || botao.direito,
  });

  // O campo de visão abre com a velocidade do salto. Aplicado aqui, depois de
  // `tuneCameraPlanes`, e SEMPRE — inclusive com o salto parado, para a lente
  // voltar ao normal se a viagem for interrompida por qualquer motivo.
  const fovAlvo = 72 + warp.deslocamentoFov;
  if (Math.abs(engine.camera.fov - fovAlvo) > 0.01) {
    engine.camera.fov = fovAlvo;
    engine.camera.updateProjectionMatrix();
  }

  // 7.05 Rede ----------------------------------------------------------------
  // Depois da física e do rebase: a posição enviada é relativa ao CENTRO DO
  // PLANETA, e ela precisa ser a deste frame já recentralizado, senão os dois
  // clientes discordam por um frame a cada recentragem.
  // Salvamento periódico. 20 s é o compromisso: perder até 20 segundos de
  // coleta é irrelevante, e uma gravação por frame transformaria o banco no
  // gargalo de um jogo que roda a 60 Hz. O `beforeunload` cobre a saída limpa.
  hud.atualizarChat(dt);
  if (started) tentarReivindicarSistema();

  if (started && contaAtiva) {
    salvarTimer -= dt;
    if (salvarTimer <= 0) {
      salvarTimer = 20;
      salvarProgresso();
    }
  }

  if (started) {
    multiplayer?.update(dt, {
      planeta: activePlanet,
      posicao: mode === 'FOOT' ? playerController.position : ship.group.position,
      quaternion: mode === 'FOOT' ? engine.camera.quaternion : ship.group.quaternion,
      modo: mode,
    });
  }

  // 7.1 Som -----------------------------------------------------------------
  // Depois da física e das ferramentas: o áudio é um ESPELHO do estado do
  // frame, nunca a origem dele. Rodando antes, o motor tocaria a rotação do
  // frame anterior — pequeno, mas some justo quando o jogador acelera, que é
  // quando ele está prestando atenção.
  if (started) {
    if (shipController.pulse !== wasPulsing) {
      if (shipController.pulse) audio.pulseEngage();
      else audio.pulseDisengage();
      wasPulsing = shipController.pulse;
    }

    updateFootsteps(dt);

    audio.update(dt, {
      throttle: shipController.braking ? 0 : shipController.throttle,
      boost: shipController.boost,
      speed: mode === 'FOOT' ? playerController.speed : shipController.speed,
      atmosphere: gameState.atmosphere,
      pulseSpool: shipController.pulseSpool,
      onFoot: mode === 'FOOT',
      mining: botao.esquerdo && ferramentaAtual().id === 'multiferramenta' && !!scanner.target,
      jetpack: playerController.jetpackActive,
      chuva: weather.intensidade,
      climaAreia: weather.clima === CLIMAS.AREIA,
    });
  }

  warpLines.update(engine.camera, shipController.velocity, mode === 'SHIP' ? shipController.pulseSpool : 0);
  ship.setThrust(
    mode === 'FOOT' ? 0 : shipController.braking ? 0 : shipController.throttle * (shipController.boost ? 1 : 0.75)
  );

  // 8. Boot ----------------------------------------------------------------
  // O cenário de URL só entra quando o terreno já chegou: aplicado antes, a
  // nave nasceria no vazio e cairia até os chunks alcançarem.
  if (!spawnApplied && starSystem.isReady && starSystem.activeChunks >= CHUNKS_TO_BOOT) {
    spawnApplied = true;
    applySpawnScenario();
  }

  if (!started) {
    const ready = starSystem.isReady && starSystem.activeChunks >= CHUNKS_TO_BOOT;
    if (ready && startButton.disabled) {
      startButton.disabled = false;
      bootStatus.textContent =
        `${starSystem.planets.length} corpos · ${homePlanet.name} (${homePlanet.config.type}) · seed ${SEED}`;
    } else if (!ready) {
      bootStatus.textContent = starSystem.isReady
        ? `Gerando terreno… ${starSystem.activeChunks}/${CHUNKS_TO_BOOT} setores`
        : 'Iniciando workers de geração…';
    }
  }

  // 9. HUD ------------------------------------------------------------------
  const { latitude, longitude } = toLatLon(gameState.up);

  biomeTimer -= dt;
  if (biomeTimer <= 0) {
    // Classificar o bioma custa 3 avaliações de fBm. O HUD mostra isso como
    // texto a 10 Hz, então recalcular 60x por segundo é desperdício de CPU —
    // e essa CPU é a que a main thread precisa para manter o render loop.
    biomeTimer = BIOME_INTERVAL;
    biomeLabel = activePlanet.biomeAt(_reference);
  }

  const chunkStats = activePlanet.chunks;
  const totalRequests = chunkStats.cacheHits + chunkStats.cacheMisses;

  hud.update(dt, {
    speed: mode === 'FOOT' ? playerController.speed : shipController.speed,
    altitude: gameState.altitude,
    phase: mode === 'FOOT' ? 'A PÉ' : shipController.pulse ? 'PULSE' : gameState.phase,
    planetName: activePlanet.name,
    planetClass: activePlanet.config.type,
    biome: biomeLabel,
    // Fora da atmosfera o clima não se aplica; mostrar "Limpo" no vácuo
    // sugeriria que existe tempo lá fora.
    clima: gameState.atmosphere > 0.5 ? weather.clima : '—',
    fauna: activePlanet.fauna.count,
    faunaEspecies: activePlanet.fauna.species.length,
    faunaAtiva: activePlanet.fauna.enabled,
    latitude,
    longitude,
    cataloged: discovery.hasPlanet(activePlanet),
    onFoot: mode === 'FOOT',
    throttle: shipController.braking ? 0 : shipController.throttle,
    jetpack: playerController.fuelRatio,
    // Os vitais mostrados são os de QUEM está levando o tiro agora: a pé é o
    // traje, pilotando é o casco. Mostrar sempre os do jogador deixaria o
    // combate de naves sem nenhuma leitura na tela.
    shield: mode === 'FOOT' ? vitaisJogador.razaoEscudo : vitaisNave.razaoEscudo,
    health: mode === 'FOOT' ? vitaisJogador.razaoVida : vitaisNave.razaoVida,
    escudoRegenerando: mode === 'FOOT' ? vitaisJogador.regenerando : vitaisNave.regenerando,
    alerta: sentinelas.nivel,
    sentinelas: sentinelas.ativas,
    atmosphere: gameState.atmosphere,
    miningProgress: scanner.miningProgress,
    units: inventory.units,
    slotsUsed: inventory.slotsUsed,
    slots: inventory.slots,
    items: inventory.entries(),
    fps: engine.fps,
    chunks: starSystem.activeChunks,
    queue: starSystem.queueLength,
    props: activePlanet.props.instanceCount,
    cacheHitRate: totalRequests > 0 ? chunkStats.cacheHits / totalRequests : 0,
  });

  hud.updateRoom(
    multiplayer
      ? {
          estado: multiplayer.estado,
          jogadores: multiplayer.conectado ? multiplayer.listar(_reference, activePlanet) : [],
        }
      : null
  );
  hud.updateMarkers(engine.camera, buildMarkers(_reference));

  hud.updateBuild(
    build.ativo
      ? {
          ativo: true,
          pecas: PECAS,
          selecao: build.selecao,
          custo: descreverCusto(build.peca, nomeDoRecurso),
          valido: build.mira?.valido ?? false,
          motivo: build.mira?.motivo ?? 'sem alvo',
        }
      : null
  );

  // Sem checar o mapa: com ele aberto este laço já retornou lá em cima.
  hud.updateHotbar(mode === 'FOOT' && started ? { ferramentas: FERRAMENTAS, atual: ferramenta } : null);
  if (painelAberto) hud.atualizarPainel({ inventario: inventory, build, recursos: RESOURCES });

  // Prompt contextual
  if (!started) hud.setPrompt(null);
  else if (painelAberto) hud.setPrompt(null);
  else if (build.ativo) hud.setPrompt(null); // a barra de construção já ocupa esse papel
  else if (canDisembark()) hud.setPrompt('<b>F</b> sair da nave');
  else if (canBoard()) hud.setPrompt('<b>F</b> embarcar');
  else if (mode === 'FOOT') {
    const f = ferramentaAtual();
    hud.setPrompt(
      `<b>Botão esq.</b> ${f.acao} &nbsp;·&nbsp; <b>dir.</b> ${f.secundaria} &nbsp;·&nbsp; <b>Tab</b> inventário`
    );
  }
  else if (shipController.pulseBlocked) hud.setPrompt(`pulse indisponível: ${shipController.pulseBlocked}`);
  else hud.setPrompt(null);
});

/* ========================================================================== */
/* Diagnóstico                                                                */
/* ========================================================================== */

if (!engine.isWebGL2) {
  console.warn('[NMS] WebGL2 indisponível — o fallback WebGL1 não foi testado.');
}

window.__nms = {
  engine, starSystem, ship, shipController, playerController,
  gameState, inventory, discovery, scanner, seed: SEED, cloudQuality, audio,
  floatingOrigin, multiplayer, build, terraform, viewModel, galaxyMap, warp, weather,
  vitaisJogador, vitaisNave, sombras, ceuAmbiente, projeteis, blaster, jogadorComoDono, hud,
  sentinelas, alvoJogador, montarAlvos, qualidade, menuPausa, medirGpu, aplicarQualidade,
  saltarPara, alternarMapa,
  get ferramenta() { return ferramentaAtual(); },
  equipar,
  get mode() { return mode; },
  get activePlanet() { return activePlanet; },
  disembark, board,
};

console.info(
  `%c[NMS] seed ${SEED} · ${starSystem.planets.length} corpos · ${homePlanet.config.name}`,
  'color:#58e8ff'
);

// Bancada de inspeção visual (`?dev=1`). O `import.meta.env.DEV` é constante
// no build, então o módulo inteiro some da produção junto com este bloco.
if (import.meta.env.DEV && params.get('dev') === '1') {
  const { installHarness } = await import('./dev/Harness.js');
  installHarness({ engine, starSystem, ship, shipController, THREE });
}
