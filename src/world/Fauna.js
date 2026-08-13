/**
 * Fauna: criaturas animadas na superfície do planeta.
 *
 * POR QUE NÃO É INSTANCIADA
 * Os props (vegetação, rochas) são milhares e imóveis, então `InstancedMesh`
 * é a escolha óbvia. Criaturas são poucas e cada uma tem pose própria a cada
 * frame — instancing não ajudaria, porque a animação altera a hierarquia
 * interna do modelo, não só a matriz do objeto.
 *
 * O QUE OS MODELOS JÁ TRAZEM
 * Os Cube Pets do Kenney vêm com os clipes `idle`, `walk`, `run` e `eat`
 * prontos, animados por transformação de nós (TRS) e **sem skinning**. Isso
 * simplifica bastante: clonar é o `Object3D.clone()` comum (o `AnimationMixer`
 * religa as faixas pelo NOME dos nós, que o clone preserva) e não há matrizes
 * de osso para atualizar por frame.
 *
 * CUSTO
 * Cada animal é uma hierarquia de ~6 meshes que se movem independentemente e
 * portanto não podem ser mescladas: ~6 draw calls por criatura. Daí o pool
 * pequeno e o frustum culling ligado — quem está fora da tela não desenha.
 */

import * as THREE from 'three';
import { mulberry32 } from '../shared/noise.js';
import { assets } from '../assets/AssetLibrary.js';
import { FAUNA_SPECIES } from '../assets/manifest.js';

/** Criaturas vivas ao mesmo tempo. Ver a nota de custo acima. */
const POOL_SIZE = 12;

/** Só existe fauna perto do chão; acima disso o pool é esvaziado. */
const ACTIVE_ALTITUDE = 260;

const SPAWN_MIN = 28;
const SPAWN_MAX = 85;
const DESPAWN = 150;

/** O jogador a menos que isto assusta a criatura. */
const FLEE_RADIUS = 15;
const FLEE_SPEED = 2.4;

const BASE_SPEED = 3.2;

const _up = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _away = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _yawQuat = new THREE.Quaternion();
const _delta = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const _box = new THREE.Box3();
const _size = new THREE.Vector3();

export class Fauna {
  /**
   * @param {import('./Planet.js').Planet} planet
   * @param {THREE.Object3D} group nó da cena, no espaço local do planeta
   */
  constructor(planet, group) {
    this.planet = planet;
    this.group = group;
    /** @type {Array<object>} */
    this.creatures = [];
    this.enabled = false;

    const rand = mulberry32((planet.config.seed ^ 0x7f4a7c15) >>> 0);

    /**
     * Espécies deste planeta.
     *
     * Cada mundo sorteia 2–3 das 10 disponíveis e aplica seu próprio matiz e
     * variação de tamanho. É o mesmo princípio do resto do projeto: pouca
     * arte, muita combinação — o jogador percebe "as criaturas daqui são
     * diferentes das de lá" sem que exista arte dedicada por planeta.
     */
    const disponiveis = [...FAUNA_SPECIES];
    const quantas = 2 + ((rand() * 2) | 0);
    this.species = [];
    for (let i = 0; i < quantas && disponiveis.length; i++) {
      const escolhida = disponiveis.splice((rand() * disponiveis.length) | 0, 1)[0];
      this.species.push({
        ...escolhida,
        // Matiz derivado da paleta do planeta, para a fauna pertencer ao mundo
        // em vez de parecer colada de outro jogo.
        tint: new THREE.Color().setHSL(rand(), 0.45 + rand() * 0.3, 0.5 + rand() * 0.2, THREE.SRGBColorSpace),
        escalaBase: 0.8 + rand() * 0.5,
      });
    }

    this._rand = rand;
    this._ready = false;
  }

  /** Carrega os modelos das espécies sorteadas. */
  async init() {
    await Promise.all(
      this.species.map(async (especie) => {
        const asset = await assets.getAnimated(especie.path);
        if (!asset) return;
        especie.asset = asset;

        // Normaliza a altura uma única vez por espécie: o modelo vem na escala
        // que o artista exportou, e `altura` no manifesto é em unidades de jogo.
        _box.setFromObject(asset.scene);
        _box.getSize(_size);
        especie.fator = especie.altura / (_size.y || 1);
      })
    );
    this.species = this.species.filter((e) => e.asset);
    this._ready = this.species.length > 0;
  }

  get count() {
    return this.creatures.length;
  }

  /** Nomes das espécies presentes — usado pelo scanner/catálogo. */
  speciesNames() {
    return this.species.map((e) => e.nome);
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} reference posição do jogador/nave
   * @param {number} altitude altitude atual acima da superfície
   */
  update(dt, reference, altitude) {
    if (!this._ready) return;

    const deveEstarAtiva = altitude < ACTIVE_ALTITUDE;
    if (deveEstarAtiva !== this.enabled) {
      this.enabled = deveEstarAtiva;
      if (!deveEstarAtiva) this._clear();
    }
    if (!this.enabled) return;

    // Repovoa o entorno conforme o jogador se desloca.
    while (this.creatures.length < POOL_SIZE) {
      const criatura = this._spawn(reference);
      if (!criatura) break;
      this.creatures.push(criatura);
    }

    for (let i = this.creatures.length - 1; i >= 0; i--) {
      const criatura = this.creatures[i];
      if (criatura.object.position.distanceTo(reference) > DESPAWN) {
        this._remove(i);
        continue;
      }
      this._updateCreature(criatura, dt, reference);
    }
  }

  _spawn(reference) {
    const especie = this.species[(this._rand() * this.species.length) | 0];
    if (!especie) return null;

    // Anel ao redor do jogador: perto o bastante para ser visto, longe o
    // bastante para não aparecer do nada na frente dele.
    const sample = this.planet.sampleAt(reference);
    _up.copy(sample.direction);
    _tangent.set(_up.z, _up.x, _up.y).cross(_up);
    if (_tangent.lengthSq() < 1e-6) _tangent.set(1, 0, 0);
    _tangent.normalize().applyAxisAngle(_up, this._rand() * Math.PI * 2);

    const distancia = SPAWN_MIN + this._rand() * (SPAWN_MAX - SPAWN_MIN);
    const posicao = reference.clone().addScaledVector(_tangent, distancia);

    const objeto = new THREE.Group();
    const modelo = especie.asset.scene.clone(true);

    // Material próprio por criatura: é o que permite o matiz da espécie sem
    // afetar as outras (o clone compartilha materiais por padrão).
    modelo.traverse((node) => {
      if (!node.isMesh) return;
      node.material = node.material.clone();
      node.material.color.multiply(especie.tint);
      node.castShadow = false;
    });

    const escala = especie.fator * especie.escalaBase * (0.85 + this._rand() * 0.3);
    modelo.scale.setScalar(escala);
    objeto.add(modelo);
    this.group.add(objeto);

    const mixer = new THREE.AnimationMixer(modelo);
    const acoes = {};
    for (const clip of especie.asset.animations) {
      acoes[clip.name] = mixer.clipAction(clip);
    }

    const criatura = {
      object: objeto,
      modelo,
      mixer,
      acoes,
      especie,
      estado: '',
      timer: 0,
      heading: _tangent.clone().applyAxisAngle(_up, this._rand() * Math.PI * 2),
      velocidade: 0,
    };

    // A posição precisa ser em espaço LOCAL do planeta: o grupo é filho dele.
    objeto.position.copy(posicao).sub(this.planet.group.position);
    this._setState(criatura, 'idle');
    return criatura;
  }

  _remove(index) {
    const criatura = this.creatures[index];
    criatura.mixer.stopAllAction();
    criatura.modelo.traverse((node) => {
      if (node.isMesh) node.material.dispose();
    });
    criatura.object.removeFromParent();
    this.creatures.splice(index, 1);
  }

  _clear() {
    for (let i = this.creatures.length - 1; i >= 0; i--) this._remove(i);
  }

  /**
   * Esvazia o pool sem destruir a instância.
   *
   * Quem chama é o loop, ao trocar de planeta ativo: só o planeta ativo recebe
   * `update()`, então o anterior nunca chegaria à checagem de altitude que
   * normalmente faz a limpeza — e ficaria com 12 criaturas andando para sempre
   * num mundo que o jogador já deixou.
   */
  despawnAll() {
    this.enabled = false;
    this._clear();
  }

  /**
   * Troca de clipe com cross-fade.
   *
   * Sem o fade a criatura "pisca" entre poses, porque cada clipe começa numa
   * pose diferente e o corte é instantâneo.
   */
  _setState(criatura, estado) {
    if (criatura.estado === estado) return;

    const anterior = criatura.acoes[criatura.estado];
    const proxima = criatura.acoes[estado] ?? criatura.acoes.idle;
    if (!proxima) return;

    proxima.reset().setEffectiveWeight(1).play();
    if (anterior && anterior !== proxima) anterior.crossFadeTo(proxima, 0.25, false);

    criatura.estado = estado;
    criatura.velocidade =
      estado === 'run' ? BASE_SPEED * FLEE_SPEED * criatura.especie.velocidade :
      estado === 'walk' ? BASE_SPEED * criatura.especie.velocidade : 0;
  }

  _updateCreature(criatura, dt, reference) {
    const objeto = criatura.object;
    const mundo = _delta.copy(objeto.position).add(this.planet.group.position);
    const sample = this.planet.sampleAt(mundo);
    _up.copy(sample.direction);

    // --- Decisão de estado -------------------------------------------------
    const distanciaJogador = mundo.distanceTo(reference);
    criatura.timer -= dt;

    if (distanciaJogador < FLEE_RADIUS) {
      // Foge na direção oposta ao jogador, projetada no plano tangente.
      _away.copy(mundo).sub(reference);
      _away.addScaledVector(_up, -_away.dot(_up));
      if (_away.lengthSq() > 1e-6) criatura.heading.copy(_away).normalize();
      this._setState(criatura, 'run');
      criatura.timer = 1.5;
    } else if (criatura.timer <= 0) {
      const sorteio = this._rand();
      if (sorteio < 0.4) {
        this._setState(criatura, 'idle');
        criatura.timer = 2 + this._rand() * 3;
      } else if (sorteio < 0.65) {
        this._setState(criatura, 'eat');
        criatura.timer = 3 + this._rand() * 4;
      } else {
        this._setState(criatura, 'walk');
        criatura.heading.applyAxisAngle(_up, (this._rand() - 0.5) * 2.2);
        criatura.timer = 3 + this._rand() * 5;
      }
    }

    // --- Movimento ---------------------------------------------------------
    // Reprojeta o rumo no plano tangente todo frame, pelo mesmo motivo do
    // jogador a pé: "para frente" muda conforme se anda sobre a esfera.
    criatura.heading.addScaledVector(_up, -criatura.heading.dot(_up));
    if (criatura.heading.lengthSq() < 1e-8) criatura.heading.set(_up.y, -_up.x, 0);
    criatura.heading.normalize();

    if (criatura.velocidade > 0) {
      objeto.position.addScaledVector(criatura.heading, criatura.velocidade * dt);
    }

    // Cola no chão (ou plana, se for espécie voadora).
    const abaixo = this.planet.sampleAt(_delta.copy(objeto.position).add(this.planet.group.position));
    const altura = criatura.especie.voa ? 1.6 + Math.sin(performance.now() * 0.002) * 0.4 : 0;
    objeto.position
      .copy(abaixo.direction)
      .multiplyScalar(abaixo.surfaceRadius + altura);

    // --- Orientação ---------------------------------------------------------
    _up.copy(abaixo.direction);
    _quat.setFromUnitVectors(Y_AXIS, _up);
    // Ângulo do rumo no plano tangente, para a criatura olhar para onde anda.
    _tangent.set(0, 0, 1).applyQuaternion(_quat);
    const angulo = Math.atan2(
      criatura.heading.dot(new THREE.Vector3(1, 0, 0).applyQuaternion(_quat)),
      criatura.heading.dot(_tangent)
    );
    _yawQuat.setFromAxisAngle(Y_AXIS, angulo);
    objeto.quaternion.copy(_quat).multiply(_yawQuat);

    criatura.mixer.update(dt);
  }

  /** Quantas criaturas dentro do raio — usado pelo pulso de varredura. */
  census(worldPoint, radius) {
    let total = 0;
    const raioSq = radius * radius;
    for (const criatura of this.creatures) {
      _delta.copy(criatura.object.position).add(this.planet.group.position);
      if (_delta.distanceToSquared(worldPoint) <= raioSq) total++;
    }
    return total;
  }

  /**
   * Censo separado por espécie, paralelo a `this.species`.
   *
   * O catálogo precisa saber QUAIS espécies estavam no raio, não só quantos
   * bichos — catalogar exige identificar. Devolve um array novo a cada chamada
   * porque a varredura é um evento raro (tecla V), não algo por frame.
   *
   * @returns {number[]}
   */
  censusBySpecies(worldPoint, radius) {
    const contagem = new Array(this.species.length).fill(0);
    const raioSq = radius * radius;
    for (const criatura of this.creatures) {
      _delta.copy(criatura.object.position).add(this.planet.group.position);
      if (_delta.distanceToSquared(worldPoint) > raioSq) continue;
      const i = this.species.indexOf(criatura.especie);
      if (i >= 0) contagem[i]++;
    }
    return contagem;
  }

  dispose() {
    this._clear();
  }
}
