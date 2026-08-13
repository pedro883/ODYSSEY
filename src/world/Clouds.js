/**
 * A camada de nuvens de um planeta: geometria, LOD de qualidade e ciclo de vida.
 *
 * A física do shader mora em `shaders/CloudShader.js`. O que está aqui é o que
 * o shader NÃO pode decidir sozinho, porque depende de onde a câmera está:
 *
 *   1. Qual face da casca renderizar (mesma armadilha da atmosfera).
 *   2. Quantos passos de marcha gastar. Do espaço, o planeta inteiro ocupa
 *      alguns milhares de pixels e 16 passos são indistinguíveis de 48; ao
 *      nível do solo, com a camada a poucas centenas de unidades, 16 passos
 *      produzem faixas visíveis. Escalar isso pela distância é a diferença
 *      entre "60 fps" e "60 fps só no planeta ativo".
 *   3. O fade: um planeta a 40 000 unidades não precisa de ray marching
 *      nenhum — a atmosfera já dá a silhueta e a nuvem não teria um pixel seu.
 */

import * as THREE from 'three';
import { createClouds } from '../shaders/CloudShader.js';

/** Acima desta distância da superfície, a camada é desligada por completo. */
const CULL_DISTANCE = 12;

/* ========================================================================== */
/* Qualidade global                                                           */
/* ========================================================================== */

/**
 * Perfis de qualidade, do mais barato ao mais caro.
 *
 * Ray marching é custo de FRAGMENTO: ele escala com a área de tela que a casca
 * cobre, e ao nível do solo isso é o céu inteiro. Por isso a qualidade não é
 * uma preferência estética — é o que decide se o jogo roda numa integrada.
 *
 * `octaves` é a alavanca mais forte, não `steps`: cada oitava são oito hashes
 * por amostra, e ela multiplica TODAS as amostras, inclusive as da marcha do
 * sol. Cair de 3 para 2 oitavas corta quase metade do trabalho e a nuvem só
 * fica com a borda menos rendilhada.
 */
const TIERS = [
  { name: 'mínimo', steps: 12, octaves: 1, lightSteps: 1 },
  { name: 'baixo',  steps: 18, octaves: 2, lightSteps: 2 },
  { name: 'médio',  steps: 24, octaves: 2, lightSteps: 3 },
  { name: 'alto',   steps: 32, octaves: 3, lightSteps: 3 },
];

/** `?clouds=off|minimo|baixo|medio|alto` fixa o nível e desliga o automático. */
function forcedTier() {
  const value = new URLSearchParams(location.search).get('clouds');
  if (!value) return null;
  // `̀-ͯ` é a faixa dos acentos combinantes: "médio" e "medio"
  // chegam iguais aqui.
  const normalized = value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (normalized === 'off' || normalized === 'nao') return -1;
  const index = ['minimo', 'baixo', 'medio', 'alto'].indexOf(normalized);
  return index >= 0 ? index : null;
}

/**
 * Controlador de qualidade, compartilhado por todos os planetas.
 *
 * ---------------------------------------------------------------------------
 * POR QUE AUTOMÁTICO E NÃO UM NÚMERO FIXO
 * ---------------------------------------------------------------------------
 * O mesmo build roda numa Iris Xe integrada e numa RTX. Escolher um valor fixo
 * significa escolher qual das duas será mal servida: conservador demais e a
 * placa boa desenha nuvens de papelão; ambicioso demais e a integrada trava.
 * O controlador mede o FPS que o jogo REALMENTE está entregando e converge.
 *
 * A histerese é o que impede a oscilação clássica (baixa qualidade -> FPS sobe
 * -> sobe qualidade -> FPS cai -> ...): descer é rápido e subir é lento, e só
 * depois de vários segundos seguidos de folga.
 */
export const cloudQuality = {
  /** Índice em `TIERS`, ou -1 para desligado. */
  tier: TIERS.length - 1,
  /** `false` quando o nível veio da URL. */
  auto: true,

  _cooldown: 0,
  _headroom: 0,

  get profile() {
    return TIERS[this.tier] ?? TIERS[0];
  },

  get enabled() {
    return this.tier >= 0;
  },

  get label() {
    return this.tier < 0 ? 'desligadas' : this.profile.name;
  },

  init() {
    const forced = forcedTier();
    if (forced !== null) {
      this.tier = forced;
      this.auto = false;
    }
  },

  /** Troca de nível avisando no console — é assim que se descobre que o
   *  controlador está atuando (e não que a GPU é ruim mesmo). */
  _set(tier, cooldown) {
    const previous = this.label;
    this.tier = tier;
    this._cooldown = cooldown;
    this._headroom = 0;
    console.info(`[NMS] nuvens: ${previous} -> ${this.label}`);
  },

  /**
   * @param {number} fps média móvel do Engine
   * @param {number} dt segundos deste frame
   */
  update(fps, dt) {
    if (!this.auto) return;

    // O FPS logo após o boot é lixo: os primeiros frames incluem compilação de
    // shader e a primeira leva de chunks. Descer de nível por causa disso
    // deixaria o jogo feio pelo resto da sessão.
    this._cooldown -= dt;
    if (this._cooldown > 0) return;

    if (fps < 40 && this.tier > 0) {
      this._set(this.tier - 1, 2.5);
    } else if (fps < 50 && this.tier > 1) {
      this._set(this.tier - 1, 2.5);
    } else if (fps > 57 && this.tier < TIERS.length - 1) {
      // Subir exige folga SUSTENTADA: um pico isolado não conta.
      this._headroom += 1;
      if (this._headroom >= 4) {
        this._set(this.tier + 1, 4);
      } else {
        this._cooldown = 1;
      }
    } else {
      this._headroom = 0;
      this._cooldown = 1;
    }
  },
};

cloudQuality.init();

export class Clouds {
  /**
   * @param {object} config saída de `createPlanetConfig()`
   * @param {THREE.Object3D} group grupo do planeta
   * @param {THREE.Vector3} center posição do planeta no mundo
   */
  constructor(config, group, center) {
    this.config = config;
    const { mesh, uniforms, inner, outer } = createClouds(config);

    this.mesh = mesh;
    this.uniforms = uniforms;
    this.inner = inner;
    this.outer = outer;
    this.uniforms.uPlanetCenter.value.copy(center);

    /**
     * O grupo do planeta, guardado para reler a posição a cada frame.
     *
     * Com origem flutuante o mundo inteiro se desloca por baixo do jogador, e
     * `uPlanetCenter` é uma posição de MUNDO: cacheada na construção, ela
     * deixaria a camada de nuvens para trás no primeiro rebase.
     */
    this.group = group;

    group.add(mesh);
  }

  /**
   * @param {THREE.Vector3} cameraLocal câmera em espaço local do planeta
   * @param {THREE.Vector3} sunDirection
   * @param {number} elapsed segundos desde o boot
   * @param {boolean} active este é o planeta em foco?
   */
  update(cameraLocal, sunDirection, elapsed, active) {
    const distance = cameraLocal.length();

    if (!cloudQuality.enabled) {
      this.mesh.visible = false;
      return;
    }

    // Fade e culling por distância. O limiar é relativo ao raio para que uma
    // lua pequena não continue desenhando nuvens quando já virou um ponto.
    const cullAt = this.outer * CULL_DISTANCE;
    if (distance > cullAt) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;

    // A nuvem some junto com a atmosfera vista de longe: entre 60% e 100% do
    // raio de corte ela desaparece, e o pixel que sobra é o da atmosfera.
    const fade = THREE.MathUtils.clamp((cullAt - distance) / (cullAt * 0.4), 0, 1);
    this.uniforms.uOpacity.value = fade;

    this.uniforms.uPlanetCenter.value.copy(this.group.position);
    this.uniforms.uSunDirection.value.copy(sunDirection);
    this.uniforms.uTime.value = elapsed;

    // Passos: cheios ao entrar na camada, mínimos em órbita alta. A altitude
    // relativa à ESPESSURA da camada é a métrica certa — é ela que diz quantas
    // amostras cabem por pixel.
    const altitude = Math.max(distance - this.outer, 0);
    const relative = altitude / (this.outer - this.inner);
    // ---------------------------------------------------------------------
    // DOIS EIXOS DE LOD, MULTIPLICADOS.
    //
    //   1. O PERFIL global (`cloudQuality`), que responde ao FPS medido e vale
    //      para o sistema inteiro — é ele que adapta o jogo ao hardware.
    //   2. A DISTÂNCIA deste planeta, aqui: quem está em órbita alta vê a
    //      camada ocupar poucos pixels e não precisa de passo fino; um planeta
    //      que nem é o ativo recebe o mínimo, porque é um disco no horizonte.
    //
    // O piso de 8 passos não é estético: abaixo disso o passo fica maior que a
    // espessura da camada e a nuvem vira uma casca lisa.
    // ---------------------------------------------------------------------
    const profile = cloudQuality.profile;
    const steps = active
      ? Math.round(THREE.MathUtils.clamp(profile.steps - relative * 3.5, 8, profile.steps))
      : Math.max(8, profile.steps >> 1);

    this.uniforms.uSteps.value = steps;
    this.uniforms.uOctaves.value = profile.octaves;
    // A marcha do sol é a que mais se paga cortar num planeta distante: ela
    // multiplica o custo de cada amostra, e de longe ninguém distingue a
    // sombra interna de um cúmulo.
    this.uniforms.uLightSteps.value = active ? profile.lightSteps : 1;

    // Dentro da casca só as faces traseiras estão à frente da câmera; fora
    // dela, só as frontais sobrevivem ao depth test sobre o disco do planeta.
    // (A explicação longa está no topo de `AtmosphereShader.js`.)
    const side = distance < this.outer ? THREE.BackSide : THREE.FrontSide;
    if (this.mesh.material.side !== side) this.mesh.material.side = side;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.removeFromParent();
  }
}
