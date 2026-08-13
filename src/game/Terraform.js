/**
 * Terraformador: cava e levanta o solo.
 *
 * ===========================================================================
 * UMA EDIÇÃO POR BURACO, NÃO UMA POR FRAME
 * ===========================================================================
 * O caminho ingênuo é emitir uma deformação a cada frame em que o botão está
 * pressionado. A 60 Hz, dois segundos cavando viram 120 registros permanentes —
 * 120 linhas no banco, 120 pacotes na rede e 120 termos que todo vértice
 * daquele chunk vai percorrer para sempre. O buraco fica caro proporcionalmente
 * ao tempo que se passou olhando para ele.
 *
 * Aqui a escavação em curso é UMA edição que vai ganhando profundidade. Só
 * quando a mira se afasta o bastante do centro dela é que uma nova começa. Uma
 * cratera inteira costuma custar duas ou três edições, e o custo passa a
 * acompanhar a ÁREA mexida em vez do tempo gasto.
 *
 * O preço é que o servidor precisa aceitar atualização de uma edição que já
 * existe, e não só inserção — daí o `id` gerado no cliente e a chave primária
 * `(seed, planeta, id)` no banco.
 */

import * as THREE from 'three';
import { EDICAO } from '../shared/edits.js';

/**
 * Alcance do terraformador, em unidades de mundo.
 *
 * Maior que o do feixe de mineração (14) e menor que o da construção era: uma
 * ferramenta que remodela o chão precisa alcançar além do raio da própria
 * deformação, senão cavar sempre abriria um buraco debaixo dos próprios pés.
 */
const ALCANCE = 20;

/** Raio da deformação. */
export const RAIO_PADRAO = 7;

/** Profundidade/altura máxima de UMA edição. */
const AMPLITUDE_MAXIMA = 9;

/** Unidades de deslocamento por segundo com o botão pressionado. */
const VELOCIDADE = 7;

/**
 * Quanto a mira precisa andar para começar uma edição nova, como fração do raio.
 *
 * Um raio INTEIRO, e não a fração de antes. O motivo é sutil e só apareceu ao
 * medir: enquanto o buraco fundo, a superfície desce, o raio da mira passa a
 * encontrar o chão mais adiante e o ponto mirado escorrega sozinho — sem o
 * jogador mexer o mouse. Com limiar baixo, cada meio segundo de escavação
 * parada gerava uma edição nova, e um buraco custava sete registros
 * permanentes em vez de um.
 */
const LIMIAR_NOVA = 1.0;

/**
 * Carência antes de permitir uma edição nova, em segundos.
 *
 * Segunda linha de defesa contra o mesmo problema: mesmo com a mira andando de
 * verdade, escavar continuamente não deve produzir mais que ~3 registros por
 * segundo. É o análogo do orçamento de voxels do gênero — o custo permanente
 * de uma escavação tem de acompanhar a ÁREA mexida, nunca o tempo gasto.
 */
const CARENCIA_NOVA = 0.35;

const _p = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3();

let contador = 0;
function novoId() {
  // Curto de propósito: é chave de banco (`CHAR(16)`) e viaja em toda edição.
  const aleatorio = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${aleatorio}${(contador++ & 0xffff).toString(16).padStart(4, '0')}`;
}

export class Terraform {
  /** @param {import('../world/StarSystem.js').StarSystem} starSystem */
  constructor(starSystem, scene) {
    this.starSystem = starSystem;

    /** Edição sendo esculpida agora, ou null. */
    this.atual = null;
    this.planetaAtual = null;

    /** Resultado da mira deste frame — o HUD e o marcador leem daqui. */
    this.mira = null;
    this.raio = RAIO_PADRAO;

    // --- Marcador da área afetada -----------------------------------------
    // Anel achatado, deitado sobre o terreno. Um cursor pontual não responde à
    // única pergunta que importa antes de cavar: "quanto disto vai sumir?".
    const geometria = new THREE.RingGeometry(0.86, 1, 48);
    geometria.rotateX(-Math.PI / 2); // deitado no plano XZ, +Y para fora
    this.marcador = new THREE.Mesh(
      geometria,
      new THREE.MeshBasicMaterial({
        color: 0x58e8ff,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      })
    );
    this.marcador.visible = false;
    this.marcador.frustumCulled = false;
    scene.add(this.marcador);
  }

  /**
   * Onde o terraformador está apontando.
   * @returns {{ponto:THREE.Vector3, dir:THREE.Vector3}|null}
   */
  mirar(olho, direcao, planeta, ativo) {
    this.mira = null;
    if (!ativo) {
      this.marcador.visible = false;
      return null;
    }

    // Mesma marcha do resto do jogo: o amostrador analítico responde igual mesmo
    // onde a malha do chunk ainda não chegou (ver `BuildSystem._mirarNoTerreno`).
    for (let d = 1.5; d <= ALCANCE; d += 0.5) {
      _p.copy(olho).addScaledVector(direcao, d);
      const amostra = planeta.sampleAt(_p);
      if (amostra.altitude > 0) continue;

      // Recoloca o ponto exatamente na superfície: parar no passo que furou o
      // chão deixaria o marcador enterrado até meia unidade.
      _dir.copy(amostra.direction);
      _p.copy(planeta.group.position).addScaledVector(_dir, amostra.surfaceRadius);

      this.mira = { ponto: _p.clone(), dir: _dir.clone(), planeta };
      this._posicionarMarcador();
      return this.mira;
    }

    this.marcador.visible = false;
    return null;
  }

  _posicionarMarcador() {
    // Um pouco acima do solo: exatamente na superfície, o anel briga com o
    // terreno no depth buffer e pisca conforme a câmera se move.
    this.marcador.position.copy(this.mira.ponto).addScaledVector(this.mira.dir, 0.15);
    this.marcador.scale.setScalar(this.raio);
    _up.set(0, 1, 0);
    this.marcador.quaternion.setFromUnitVectors(_up, this.mira.dir);
    this.marcador.visible = true;
  }

  /**
   * Esculpe enquanto o botão estiver pressionado.
   *
   * @param {number} dt
   * @param {number} sentido +1 levanta, -1 cava
   * @returns {object|null} a edição a propagar neste frame, ou null
   */
  esculpir(dt, sentido) {
    const mira = this.mira;
    if (!mira) return null;

    const planeta = mira.planeta;
    const dir = mira.dir;

    this._desdeNova = (this._desdeNova ?? CARENCIA_NOVA) + dt;

    // Recomeça quando a mira sai do miolo da edição atual, quando troca de
    // planeta ou quando inverte o sentido — cavar sobre um monte que se acabou
    // de levantar tem de virar buraco, não desfazer o registro anterior.
    const longe =
      !this.atual ||
      this.planetaAtual !== planeta ||
      Math.sign(this.atual.f || sentido) !== sentido ||
      (this._desdeNova >= CARENCIA_NOVA &&
        _dir.set(this.atual.x, this.atual.y, this.atual.z).distanceTo(dir) * planeta.config.radius >
          this.raio * LIMIAR_NOVA);

    if (longe) {
      this._desdeNova = 0;
      this.atual = {
        id: novoId(),
        x: dir.x, y: dir.y, z: dir.z,
        r: this.raio,
        f: 0,
        t: EDICAO.SOMAR,
      };
      this.planetaAtual = planeta;
    }

    const passo = VELOCIDADE * dt * sentido;
    const novo = THREE.MathUtils.clamp(this.atual.f + passo, -AMPLITUDE_MAXIMA, AMPLITUDE_MAXIMA);
    if (novo === this.atual.f) return null; // já no limite: não gera tráfego

    this.atual.f = novo;
    // Cópia: quem recebe (rede, banco) não pode segurar uma referência que
    // continua mudando debaixo dele no frame seguinte.
    const edicao = { ...this.atual };
    planeta.aplicarEdicao(edicao);
    return { edicao, planeta: this.starSystem.planets.indexOf(planeta) };
  }

  /** Solta a escavação em curso (botão liberado). */
  soltar() {
    this.atual = null;
    this.planetaAtual = null;
  }

  dispose() {
    this.marcador.geometry.dispose();
    this.marcador.material.dispose();
    this.marcador.removeFromParent();
  }
}
