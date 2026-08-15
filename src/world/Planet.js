/**
 * Um corpo planetário completo: quadtrees de superfície, oceano, atmosfera e
 * vegetação.
 *
 * Nada aqui é pré-calculado ou armazenado em disco — o planeta inteiro é
 * reconstruído a partir de `config.seed` toda vez. Instanciar outro planeta é
 * `new Planet(seed, scene, posição, pool, id)`; o pool de workers é
 * compartilhado por todo o sistema estelar.
 */

import * as THREE from 'three';
import { createPlanetConfig } from './PlanetConfig.js';
import { createTerrainSampler, CUBE_FACES } from '../shared/terrain.js';
import { ChunkManager } from './ChunkManager.js';
import { QuadTreeNode } from './QuadTreeNode.js';
import { PropScatter } from './PropScatter.js';
import { Fauna } from './Fauna.js';
import { createAtmosphere } from '../shaders/AtmosphereShader.js';
import { criarOceano } from '../shaders/OceanShader.js';
import { Clouds } from './Clouds.js';
import { CampoDeEdicoes } from '../shared/edits.js';
import { criarCampoDeDensidade } from '../shared/densidade.js';
import { criarSonda } from '../shared/sonda.js';
import { CascaProfunda } from './CascaProfunda.js';

/**
 * Terreno volumétrico (`?volumetrico=1`). Mesmo interruptor do `ChunkManager`.
 */
const VOLUMETRICO =
  typeof location !== 'undefined' &&
  new URLSearchParams(location.search).get('volumetrico') === '1';

/**
 * Até onde a sonda procura o chão, em unidades.
 *
 * Precisa cobrir a caverna mais funda que o chunk desenha (a casca vai a 90
 * unidades abaixo da elevação mínima) com folga para o jogador estar caindo.
 */
const ALCANCE_SONDA = 260;

/**
 * Altura acima da superfície em que a sonda ainda é consultada.
 *
 * É o que permite CAIR numa boca de caverna: sobre ela o campo de altura mente,
 * e sem esta faixa o jogador andaria por cima do buraco. Estreita de propósito —
 * cada consulta custa uma marcha.
 */
const ALTURA_SONDAVEL = 6;

/** Direção reaproveitada nas consultas à sonda (ver `sampleAt`). */
const _dirSonda = [0, 0, 0];

const _tangentA = new THREE.Vector3();
const _tangentB = new THREE.Vector3();
const _edicaoDir = new THREE.Vector3();
const _edicaoPonto = new THREE.Vector3();

/**
 * Silêncio necessário antes de reconstruir o terreno escavado, em segundos.
 *
 * Curto: é o que separa "soltei o botão" de "o buraco apareceu". Ver
 * `Planet._marcarSujo`.
 */
const ESPERA_APOS_ULTIMA = 0.18;

/**
 * Teto de espera, mesmo com a escavação em andamento.
 *
 * Sem ele, quem cava sem soltar o botão nunca veria o resultado — o relógio
 * curto seria reiniciado a cada frame para sempre.
 */
const ESPERA_MAXIMA = 0.75;

export class Planet {
  /**
   * @param {number} seed
   * @param {THREE.Scene} scene
   * @param {THREE.Vector3} position posição do planeta no sistema
   * @param {import('../workers/WorkerPool.js').WorkerPool} pool
   * @param {number} planetId identificador dentro do pool compartilhado
   * @param {number} scale tamanho relativo do corpo (ver `PlanetConfig.js`)
   */
  constructor(seed, scene, position, pool, planetId, scale = 1) {
    this.config = createPlanetConfig(seed, scale);
    this.planetId = planetId;

    /**
     * Escavações permanentes (`shared/edits.js`).
     *
     * A cópia da main thread precisa existir e ficar sincronizada com a dos
     * workers pela mesma razão de sempre: é ela que responde altitude e colisão.
     * Se o worker souber do buraco e a main thread não, o jogador cai numa
     * cratera e continua andando no ar sobre o chão que não existe mais.
     */
    this.edicoes = new CampoDeEdicoes(this.config.radius);

    /** Regiões esperando reconstrução (ver `_marcarSujo`). @type {Map<string,object>} */
    this._sujos = new Map();
    this._esperaSujo = 0;
    this._esperaMaxima = 0;
    /** Segunda varredura após a fila drenar (ver `definirEdicoes`). */
    this._revalidar = null;
    this._ultimoElapsed = 0;

    // O MESMO amostrador que roda dentro dos workers. Aqui ele serve para
    // altitude da nave, colisão e posicionamento dos nós da quadtree — se as
    // duas implementações divergissem, a nave atravessaria o chão visível.
    this.sampler = createTerrainSampler(this.config, this.edicoes);

    // A sonda responde "onde está o chão" quando o chão pode não ser a
    // superfície — isto é, dentro de uma caverna. Criada só no modo volumétrico:
    // no campo de altura a resposta é uma amostra e marchar seria desperdício.
    // Compartilha o MESMO `sampler`, logo enxerga as escavações do jogador.
    this.sonda = VOLUMETRICO
      ? criarSonda(criarCampoDeDensidade(this.config, this.sampler.heightAt))
      : null;

    this.pool = pool;

    this.group = new THREE.Group();
    this.group.position.copy(position);
    scene.add(this.group);

    this.terrainGroup = new THREE.Group();
    this.group.add(this.terrainGroup);

    pool.register(planetId, this.config);
    this.chunks = new ChunkManager(this.config, this.terrainGroup, pool, planetId);

    this.props = new PropScatter(this, this.terrainGroup);
    this.chunks.props = this.props;

    // -----------------------------------------------------------------------
    // FAIXAS PROFUNDAS: DESLIGADAS ENQUANTO AS CAVERNAS NÃO DESCEM ATÉ LÁ.
    //
    // `profundidadeMaxima` caiu para 74 unidades — a casca que a quadtree malha
    // vai até 90, e cavernas mais fundas ficavam SEM PISO, deixando ver o outro
    // lado do planeta. Com a rede inteira dentro da faixa 0, tudo abaixo dela é
    // rocha maciça, e pedir essas faixas gera malha vazia: trabalho de worker
    // por nada.
    //
    // O código fica, e `?fundo=1` o liga. Ele volta a valer no dia em que as
    // cavernas voltarem a descer — que é o que o passo 3b existe para permitir.
    // -----------------------------------------------------------------------
    const querFundo =
      typeof location !== 'undefined' &&
      new URLSearchParams(location.search).get('fundo') === '1';
    this.cascaProfunda = VOLUMETRICO && querFundo ? new CascaProfunda(this, this.terrainGroup) : null;
    this.chunks.cascaProfunda = this.cascaProfunda;

    // A fauna carrega seus modelos de forma assíncrona; até lá ela fica
    // inerte, o que é aceitável porque só aparece perto do solo — e chegar lá
    // leva muito mais tempo do que carregar 3 arquivos de 140 KB.
    this.fauna = new Fauna(this, this.terrainGroup);
    this.fauna.init();

    // Uma quadtree por face do cubo. Cada raiz cobre 1/6 do planeta.
    this.roots = CUBE_FACES.map((_, face) => new QuadTreeNode(this, face, 0, 0, 1, 0));

    // --- Oceano ------------------------------------------------------------
    // Casca no nível do mar com shader próprio: ondas, espuma na arrebentação e
    // cor por profundidade amostrada do próprio relevo. Ver `OceanShader.js`.
    if (this.config.hasWater) {
      this.oceano = criarOceano(this.config, this.sampler.heightAt);
      this.ocean = this.oceano.mesh;
      this.group.add(this.ocean);
    }

    // --- Atmosfera ---------------------------------------------------------
    const atmosphere = createAtmosphere(this.config);
    this.atmosphereMesh = atmosphere.mesh;
    this.atmosphereUniforms = atmosphere.uniforms;
    this.atmosphereUniforms.uPlanetCenter.value.copy(position);
    this.group.add(this.atmosphereMesh);

    // --- Nuvens ------------------------------------------------------------
    // Casca separada da atmosfera, desenhada ANTES dela (renderOrder 5 contra
    // 10): a atmosfera precisa espalhar por cima das nuvens, senão o cúmulo
    // fica com a mesma cor ao meio-dia e no pôr do sol.
    this.clouds = new Clouds(this.config, this.group, position);

    this._localPoint = new THREE.Vector3();

    /**
     * Resultado reaproveitado de `sampleAt()`. Por INSTÂNCIA e não por módulo:
     * com vários planetas no sistema, um objeto compartilhado seria sobrescrito
     * assim que outro planeta fosse consultado no mesmo frame.
     */
    this._sample = {
      distance: 0,
      surfaceRadius: 0,
      altitude: 0,
      direction: new THREE.Vector3(),
      elevation: 0,
    };
  }

  get name() {
    return this.config.name;
  }

  get radius() {
    return this.config.radius;
  }

  get atmosphereRadius() {
    return this.config.radius + this.config.atmosphere.height;
  }

  /**
   * Atualiza LOD e fila de geração.
   * @param {THREE.Vector3} cameraWorld posição da câmera em espaço de mundo
   * @param {THREE.Vector3} sunDirection direção normalizada até o sol
   * @param {number} elapsed segundos desde o boot (deriva das nuvens)
   */
  update(cameraWorld, sunDirection, elapsed) {
    const cameraLocal = this._localPoint.copy(cameraWorld).sub(this.group.position);

    // O `dt` é derivado do relógio do sistema estelar em vez de entrar por
    // parâmetro: mudar a assinatura de `updatePlanets` obrigaria os quatro
    // corpos a repassá-lo só porque um deles pode estar sendo escavado.
    const dt = Math.min(0.1, Math.max(0, elapsed - this._ultimoElapsed));
    this._ultimoElapsed = elapsed;

    this._processarSujos(dt);
    this._passoRevalidacao();
    for (const root of this.roots) root.update(cameraLocal);
    this.chunks.update(cameraLocal);

    // DEPOIS da quadtree: a casca profunda pendura suas faixas nas folhas dela,
    // e rodar antes leria a subdivisão do quadro anterior.
    if (this.cascaProfunda) {
      // A elevação vem do amostrador DIRETO, e não de `sampleAt`.
      //
      // `sampleAt` devolve sempre o MESMO objeto `_sample`, e `_sample.direction`
      // é reaproveitado como rascunho lá dentro. Passar por ele aqui — no meio
      // do `update`, entre a quadtree e as nuvens — misturava dois usuários do
      // mesmo rascunho e a profundidade saía absurda: medi -5325 onde o valor
      // certo era +252. Duas linhas diretas não têm esse risco.
      const dist = cameraLocal.length() || 1;
      const elev = this.sampler.heightAt(
        cameraLocal.x / dist, cameraLocal.y / dist, cameraLocal.z / dist
      );
      this.cascaProfunda.atualizar(cameraLocal, elev);
    }

    // O centro vai para o shader TODO FRAME, não só na construção. Ele é uma
    // posição de MUNDO, e com origem flutuante o mundo se desloca por baixo do
    // planeta — um valor cacheado deixaria a atmosfera para trás no primeiro
    // rebase, desenhando o halo a milhares de unidades do planeta.
    this.atmosphereUniforms.uPlanetCenter.value.copy(this.group.position);
    this.atmosphereUniforms.uSunDirection.value.copy(sunDirection);
    this.setAtmosphereSide(cameraLocal.lengthSq() < this.atmosphereRadius * this.atmosphereRadius);
    this.clouds.update(cameraLocal, sunDirection, elapsed, true);
    // A câmera vai em espaço LOCAL do planeta porque é nele que a casca do
    // oceano vive — o shader compara com `position`, que é local por definição.
    this.oceano?.atualizar(cameraLocal, sunDirection, elapsed);
  }

  /**
   * Atualização barata para planetas distantes: só a atmosfera e o LOD
   * grosseiro. Evita percorrer 900 nós de quadtree de um mundo que está a
   * 40 000 unidades e ocupa 20 pixels na tela.
   */
  updateDistant(cameraWorld, sunDirection, elapsed) {
    const cameraLocal = this._localPoint.copy(cameraWorld).sub(this.group.position);
    // Também aqui: alguém pode ter escavado neste corpo e voado para longe, e
    // a reconstrução pendente não pode ficar presa esperando o jogador voltar.
    const dt = Math.min(0.1, Math.max(0, elapsed - this._ultimoElapsed));
    this._ultimoElapsed = elapsed;
    this._processarSujos(dt);
    this._passoRevalidacao();
    for (const root of this.roots) root.update(cameraLocal);
    this.chunks.update(cameraLocal);
    this.atmosphereUniforms.uPlanetCenter.value.copy(this.group.position);
    this.atmosphereUniforms.uSunDirection.value.copy(sunDirection);
    this.setAtmosphereSide(false);
    this.clouds.update(cameraLocal, sunDirection, elapsed, false);
    // De longe as ondas não se distinguem, mas o sol e a câmera sim: sem esta
    // linha o brilho especular do mar ficaria congelado na direção em que a
    // nave estava quando saiu do planeta.
    this.oceano?.atualizar(cameraLocal, sunDirection, elapsed);
  }

  /**
   * Escolhe qual face da casca atmosférica é renderizada.
   * Ver a explicação longa no topo de `AtmosphereShader.js` — em resumo:
   * de fora, as faces frontais são as únicas que sobrevivem ao depth test
   * sobre o disco do planeta; de dentro, só as traseiras estão à frente da
   * câmera. Trocar `side` é estado de renderização, não exige recompilar
   * o shader.
   *
   * @param {boolean} inside a câmera está dentro da casca?
   */
  setAtmosphereSide(inside) {
    const side = inside ? THREE.BackSide : THREE.FrontSide;
    if (this.atmosphereMesh.material.side !== side) {
      this.atmosphereMesh.material.side = side;
    }
  }

  /**
   * Consulta o terreno sob uma posição de mundo.
   * Devolve SEMPRE o mesmo objeto — copie o que precisar guardar.
   *
   * @param {THREE.Vector3} worldPosition
   */
  sampleAt(worldPosition) {
    const sample = this._sample;
    const local = sample.direction.copy(worldPosition).sub(this.group.position);
    const distance = local.length();
    // Guarda contra a singularidade exata no centro do planeta.
    local.divideScalar(distance || 1);

    const elevation = this.sampler.heightAt(local.x, local.y, local.z);

    // Em mundos com oceano o "chão" para pouso é o nível do mar, não o fundo.
    const groundElevation = this.config.hasWater ? Math.max(elevation, 0) : elevation;

    sample.distance = distance;
    sample.elevation = elevation;
    sample.surfaceRadius = this.config.radius + groundElevation;
    sample.altitude = distance - sample.surfaceRadius;

    // -----------------------------------------------------------------------
    // TERRENO VOLUMÉTRICO: O CHÃO PODE NÃO SER A SUPERFÍCIE.
    //
    // Dentro de uma caverna, o chão é o piso dela — dezenas de unidades abaixo
    // do relevo. Sem isto o jogador entraria na caverna e continuaria sendo
    // empurrado para a altitude do terreno lá fora, ou seja, atravessaria o teto
    // de baixo para cima.
    //
    // A GUARDA É O QUE MANTÉM O CUSTO. A sonda custa 3,7 µs contra os 0,88 µs
    // de uma amostra de altura, e `sampleAt` é chamado dezenas de vezes por
    // quadro (nave, jogador, cada criatura, cada projétil). Mas as cavernas só
    // existem ABAIXO da superfície — `margemTeto` garante rocha maciça logo
    // sob ela —, então quem está acima do relevo já tem a resposta certa e não
    // marcha. Na prática só paga quem está de fato dentro de uma caverna.
    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------
    // A CONDIÇÃO É ESTAR ABAIXO DO TERRENO, NÃO ABAIXO DO "CHÃO DE POUSO".
    //
    // A primeira versão usava `sample.altitude < 0`, e isso quebrou o oceano.
    // Em mundo com água, `surfaceRadius` é deliberadamente o NÍVEL DO MAR e não
    // o fundo — é essa convenção que faz a nave pousar na água e o jogador
    // boiar. Debaixo d'água a altitude é quase sempre negativa, então a sonda
    // disparava a todo instante e substituía o nível do mar pelo FUNDO,
    // dezenas de unidades abaixo.
    //
    // O sintoma foi o jogador subindo sozinho, ~0,5 unidade por segundo, com
    // `grounded` nunca verdadeiro: a cada quadro o jogo era informado de um
    // chão muito mais fundo do que o real e a flutuação o empurrava.
    //
    // Estar dentro de uma caverna é estar abaixo do TERRENO (rocha), que é
    // `radius + elevation` — sem o `max(…, 0)` do nível do mar.
    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------
    // A SONDA VALE TAMBÉM UM POUCO ACIMA DA SUPERFÍCIE.
    //
    // Com a regra anterior (só abaixo do terreno) era IMPOSSÍVEL entrar numa
    // caverna. Sobre a boca, `heightAt` continua reportando o relevo — ele não
    // sabe do buraco —, então o jogador pisava em chão que não existe. E no
    // instante em que afundava meio metro, a sonda finalmente respondia "o piso
    // está 43 unidades abaixo", com a colisão já tendo-o assentado na
    // superfície: ele era empurrado de volta para cima. Era exatamente o
    // relatado, "fica voltando para a superfície".
    //
    // Consultando numa faixa em torno da superfície, sobre a boca a resposta
    // passa a ser o piso da caverna desde o começo, e o jogador cai nela.
    //
    // Continua barato: a faixa é estreita, e quem está voando ou em órbita
    // (a esmagadora maioria das consultas) nem chega perto dela.
    //
    // A ressalva do oceano permanece: em água, `surfaceRadius` é o NÍVEL DO MAR
    // por convenção, e trocá-lo pelo fundo quebra pouso e flutuação.
    // -----------------------------------------------------------------------
    // A sonda trabalha com um array simples, e não com `Vector3`: ela é
    // compartilhada com os workers, onde importar a engine inteira seria
    // desperdício. Passar o `Vector3` direto daria `dir[0] === undefined` e NaN
    // silencioso em toda a colisão. Preenchido aqui porque as DUAS consultas
    // abaixo precisam dele, e elas rodam em condições diferentes.
    _dirSonda[0] = local.x; _dirSonda[1] = local.y; _dirSonda[2] = local.z;

    const emTerra = !this.config.hasWater || elevation > 0;
    if (this.sonda && emTerra && sample.altitude < ALTURA_SONDAVEL) {
      const chao = this.sonda.chaoAbaixo(_dirSonda, distance, ALCANCE_SONDA);
      if (chao !== null) {
        sample.surfaceRadius = chao;
        sample.altitude = distance - chao;
      }
    }

    return sample;
  }

  /* ===================================================================== */
  /* Escavação                                                             */
  /* ===================================================================== */

  /**
   * Aplica uma deformação e reconstrói o terreno afetado.
   *
   * A ORDEM importa e não é óbvia:
   *   1. a main thread registra a edição (colisão e altitude já respondem certo
   *      no MESMO frame — o jogador não atravessa o chão por um instante);
   *   2. os workers recebem a novidade;
   *   3. só então os chunks são descartados e repedidos.
   *
   * Invertendo 2 e 3, os pedidos sairiam antes de os workers saberem da
   * escavação e voltariam com o terreno velho — e o buraco só apareceria na
   * próxima vez que a região saísse e entrasse de cena.
   *
   * @param {{id:string,x:number,y:number,z:number,r:number,f:number,t:number}} edicao
   * @returns {boolean} houve mudança (false = edição idêntica à que já existia)
   */
  aplicarEdicao(edicao) {
    if (!this.edicoes.aplicar(edicao)) return false;

    this.pool.enviarEdicao(this.planetId, edicao);
    this._marcarSujo(edicao);
    return true;
  }

  /**
   * Enfileira uma região para reconstrução, SEM reconstruir agora.
   *
   * -----------------------------------------------------------------------
   * POR QUE NÃO INVALIDAR NA HORA
   * -----------------------------------------------------------------------
   * Enquanto o jogador segura o botão do terraformador, a mesma escavação é
   * reaplicada a cada frame com a profundidade crescendo — 60 chamadas por
   * segundo. Invalidar em cada uma descarta ~25 chunks e os repede; o pool
   * processa no máximo ~12 por vez, então a fila cresce mais rápido do que
   * drena e NENHUM chunk chega a ser entregue antes de ser descartado outra
   * vez.
   *
   * O efeito na tela é exatamente o que se relata como "glitch": o terreno
   * pisca, aparece em retalhos ou simplesmente não muda enquanto se cava — e
   * só se acerta quando o jogador para. Pior: a colisão e a altitude (que leem
   * o amostrador da main thread) já enxergam o buraco, então dá para afundar
   * num chão que continua desenhado.
   *
   * Agrupando por tempo, uma escavação de dois segundos custa duas ou três
   * reconstruções em vez de cento e vinte, e cada uma tem tempo de terminar.
   */
  _marcarSujo(edicao) {
    // Guarda uma CÓPIA: a edição em curso continua mudando de profundidade a
    // cada frame, e o que precisa ser reconstruído é a região, que não muda.
    this._sujos.set(edicao.id, { x: edicao.x, y: edicao.y, z: edicao.z, r: edicao.r });
    this._esperaSujo = ESPERA_APOS_ULTIMA;
    if (this._esperaMaxima <= 0) this._esperaMaxima = ESPERA_MAXIMA;
  }

  /**
   * Reconstrói o que foi marcado, quando for a hora.
   *
   * Dois relógios: um curto que reinicia a cada mudança (para reagir rápido
   * quando o jogador solta o botão) e um teto que dispara mesmo com a
   * escavação em andamento — sem ele, cavar sem parar nunca mostraria o
   * resultado.
   */
  _processarSujos(dt) {
    if (this._sujos.size === 0) return;

    this._esperaSujo -= dt;
    this._esperaMaxima -= dt;
    if (this._esperaSujo > 0 && this._esperaMaxima > 0) return;

    for (const regiao of this._sujos.values()) this._invalidarRegiao(regiao);
    this._sujos.clear();
    this._esperaSujo = 0;
    this._esperaMaxima = 0;
  }

  /** Desfaz uma deformação (a base que a gerou foi demolida). */
  removerEdicao(id) {
    const edicao = this.edicoes.porId.get(id);
    if (!edicao) return false;
    // A cópia precisa ser feita ANTES da remoção: é a região dela que dita
    // quais chunks estão errados agora.
    const regiao = { ...edicao };
    this.edicoes.remover(id);
    this.pool.enviarEdicoes(this.planetId, this.edicoes.paraLista());
    this._invalidarRegiao(regiao);
    return true;
  }

  /**
   * Restaura um conjunto inteiro (entrada na sala).
   *
   * MESCLA em vez de substituir. Substituir seria o comportamento óbvio para um
   * método com este nome, e apagaria os platôs das bases: eles não vêm da rede
   * — cada cliente os deriva das peças (ver `BuildSystem._aplainar`) — e uma
   * substituição os varreria junto, deixando toda base restaurada boiando sobre
   * o relevo original até alguém encostar nela.
   *
   * Os dois conjuntos têm identificadores disjuntos (o platô usa o id da base),
   * então mesclar é seguro e idempotente.
   */
  definirEdicoes(lista) {
    if (lista.length === 0) return;
    for (const edicao of lista) this.edicoes.aplicar(edicao);

    // Uma remessa só para os workers, e só então a invalidação: é o que evita a
    // corrida em que um chunk é regerado antes de o worker conhecer a escavação
    // seguinte da mesma leva.
    this.pool.enviarEdicoes(this.planetId, this.edicoes.paraLista());
    for (const edicao of lista) this._invalidarRegiao(edicao);

    // -----------------------------------------------------------------------
    // SEGUNDA PASSADA, ALGUNS FRAMES DEPOIS.
    //
    // A restauração chega no MEIO da geração do terreno, e não antes dela: o
    // `join` que a provoca só é enviado quando já existem chunks suficientes
    // para liberar o jogo (ver `applySpawnScenario` em `main.js`). Nesse
    // instante há dezenas de chunks em voo, pedidos a workers que ainda não
    // conheciam as escavações — e eles chegam DEPOIS desta invalidação, já
    // aceitos e com o relevo antigo.
    //
    // O sintoma era exato e confuso: a cratera existia para a colisão e para a
    // altitude (que consultam o amostrador da main thread) e não existia na
    // malha. Dava para cair num buraco invisível.
    //
    // Uma segunda varredura depois que a fila esvazia resolve sem precisar de
    // um protocolo de confirmação por chunk.
    // -----------------------------------------------------------------------
    this._revalidar = { lista, frames: 120 };
  }

  /** Passo da segunda varredura descrita em `definirEdicoes`. */
  _passoRevalidacao() {
    if (!this._revalidar) return;
    // Espera a fila esvaziar OU o prazo acabar; o que vier primeiro.
    const fila = this.chunks.queueLength;
    if (fila > 0 && --this._revalidar.frames > 0) return;

    for (const edicao of this._revalidar.lista) this._invalidarRegiao(edicao);
    this._revalidar = null;
  }

  _invalidarRegiao(edicao) {
    // Folga de 15%: a deformação vai a zero na borda do raio, mas as NORMAIS do
    // chunk vizinho foram calculadas com os vértices de padding que caem dentro
    // dele. Sem a folga, sobra um vinco de iluminação no anel externo.
    const raioAngular = (edicao.r * 1.15) / this.config.radius;
    for (const root of this.roots) root.invalidar(_edicaoDir.set(edicao.x, edicao.y, edicao.z), raioAngular);

    _edicaoPonto
      .copy(_edicaoDir)
      .multiplyScalar(this.config.radius + this.sampler.heightAt(edicao.x, edicao.y, edicao.z));
    this.chunks.purgarCache(_edicaoPonto, edicao.r * 1.15);
  }

  /** Declive do terreno em [0,1] sob uma posição. */
  slopeAt(worldPosition) {
    const s = this.sampleAt(worldPosition);
    const d = s.direction;

    const eps = 0.0004;
    const tangent = _tangentA.set(-d.y, d.x, 0);
    if (tangent.lengthSq() < 1e-8) tangent.set(1, 0, 0);
    tangent.normalize();
    const bitangent = _tangentB.crossVectors(d, tangent);

    const hA = this.sampler.heightAt(d.x + tangent.x * eps, d.y + tangent.y * eps, d.z + tangent.z * eps);
    const hB = this.sampler.heightAt(d.x + bitangent.x * eps, d.y + bitangent.y * eps, d.z + bitangent.z * eps);
    const run = this.config.radius * eps;
    return Math.min(1, Math.hypot(hA - s.elevation, hB - s.elevation) / (run || 1));
  }

  /** Nome do bioma sob a posição. */
  biomeAt(worldPosition) {
    const slope = this.slopeAt(worldPosition);
    const s = this.sampleAt(worldPosition);
    return this.sampler.biomeAt(s.direction.x, s.direction.y, s.direction.z, s.elevation, slope);
  }

  dispose() {
    for (const root of this.roots) root.dispose();
    this.chunks.dispose();
    this.cascaProfunda?.dispose();
    this.props.dispose();
    this.fauna.dispose();
    this.clouds.dispose();

    this.atmosphereMesh.geometry.dispose();
    this.atmosphereMesh.material.dispose();
    this.oceano?.dispose();
    this.group.removeFromParent();
  }
}
