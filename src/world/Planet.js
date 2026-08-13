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
import { Clouds } from './Clouds.js';
import { CampoDeEdicoes } from '../shared/edits.js';

const _tangentA = new THREE.Vector3();
const _tangentB = new THREE.Vector3();
const _edicaoDir = new THREE.Vector3();
const _edicaoPonto = new THREE.Vector3();

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

    // O MESMO amostrador que roda dentro dos workers. Aqui ele serve para
    // altitude da nave, colisão e posicionamento dos nós da quadtree — se as
    // duas implementações divergissem, a nave atravessaria o chão visível.
    this.sampler = createTerrainSampler(this.config, this.edicoes);
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

    // A fauna carrega seus modelos de forma assíncrona; até lá ela fica
    // inerte, o que é aceitável porque só aparece perto do solo — e chegar lá
    // leva muito mais tempo do que carregar 3 arquivos de 140 KB.
    this.fauna = new Fauna(this, this.terrainGroup);
    this.fauna.init();

    // Uma quadtree por face do cubo. Cada raiz cobre 1/6 do planeta.
    this.roots = CUBE_FACES.map((_, face) => new QuadTreeNode(this, face, 0, 0, 1, 0));

    // --- Oceano ------------------------------------------------------------
    // Esfera simples no nível do mar. Barato e resolve 90% da leitura visual:
    // o relevo abaixo de zero já foi gerado como fundo submarino.
    if (this.config.hasWater) {
      const waterColor = new THREE.Color().fromArray(this.config.waterColor);
      this.ocean = new THREE.Mesh(
        new THREE.SphereGeometry(this.config.radius, 128, 96),
        new THREE.MeshStandardMaterial({
          color: waterColor,
          transparent: true,
          opacity: 0.85,
          roughness: 0.06,
          metalness: 0.15,
        })
      );
      this.ocean.renderOrder = 1;
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

    this._passoRevalidacao();
    for (const root of this.roots) root.update(cameraLocal);
    this.chunks.update(cameraLocal);

    // O centro vai para o shader TODO FRAME, não só na construção. Ele é uma
    // posição de MUNDO, e com origem flutuante o mundo se desloca por baixo do
    // planeta — um valor cacheado deixaria a atmosfera para trás no primeiro
    // rebase, desenhando o halo a milhares de unidades do planeta.
    this.atmosphereUniforms.uPlanetCenter.value.copy(this.group.position);
    this.atmosphereUniforms.uSunDirection.value.copy(sunDirection);
    this.setAtmosphereSide(cameraLocal.lengthSq() < this.atmosphereRadius * this.atmosphereRadius);
    this.clouds.update(cameraLocal, sunDirection, elapsed, true);
  }

  /**
   * Atualização barata para planetas distantes: só a atmosfera e o LOD
   * grosseiro. Evita percorrer 900 nós de quadtree de um mundo que está a
   * 40 000 unidades e ocupa 20 pixels na tela.
   */
  updateDistant(cameraWorld, sunDirection, elapsed) {
    const cameraLocal = this._localPoint.copy(cameraWorld).sub(this.group.position);
    for (const root of this.roots) root.update(cameraLocal);
    this.chunks.update(cameraLocal);
    this.atmosphereUniforms.uPlanetCenter.value.copy(this.group.position);
    this.atmosphereUniforms.uSunDirection.value.copy(sunDirection);
    this.setAtmosphereSide(false);
    this.clouds.update(cameraLocal, sunDirection, elapsed, false);
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
    this._invalidarRegiao(edicao);
    return true;
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
    this.props.dispose();
    this.fauna.dispose();
    this.clouds.dispose();

    this.atmosphereMesh.geometry.dispose();
    this.atmosphereMesh.material.dispose();
    if (this.ocean) {
      this.ocean.geometry.dispose();
      this.ocean.material.dispose();
    }
    this.group.removeFromParent();
  }
}
