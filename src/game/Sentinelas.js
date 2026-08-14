/**
 * Sentinelas planetárias: drones que reagem ao que o jogador faz.
 *
 * ===========================================================================
 * O QUE ESTE SISTEMA RESOLVE
 * ===========================================================================
 * A fauna hostil dá perigo, mas perigo AMBIENTE: ela não liga para o que o
 * jogador faz, só para onde ele está. Sentinelas são a outra metade — uma
 * ameaça que o jogador PROVOCA, e que portanto ele pode escolher evitar. É a
 * diferença entre um mundo perigoso e um mundo com regras.
 *
 * ===========================================================================
 * NÍVEL DE ALERTA CONTÍNUO, EXIBIDO EM ESTRELAS
 * ===========================================================================
 * A suspeita é um número real que sobe por infração e escorre com o tempo; o
 * "nível" mostrado é o piso dela. Guardar um inteiro e mexer nele direto seria
 * mais simples e daria um sistema pior: sem fração não existe "quase subindo
 * de nível", e o jogador não teria como sentir que está perto do limite antes
 * de cruzá-lo.
 *
 * A queda tem CARÊNCIA (`ESPERA_QUEDA`). Sem ela o alerta cairia entre dois
 * tiros e o jogador se livraria da perseguição parando de atirar por um
 * segundo — a mesma razão do atraso na regeneração de escudo em `Vitals.js`.
 *
 * ===========================================================================
 * POR QUE ELES MANTÊM DISTÂNCIA
 * ===========================================================================
 * O predador de `Fauna.js` cola no jogador e morde. Se o drone fizesse igual,
 * os dois inimigos do jogo se comportariam do mesmo jeito e a diferença entre
 * eles seria só o modelo. O drone para a alguns metros e ATIRA — o que muda o
 * que o jogador precisa fazer: contra a fauna ele recua, contra a sentinela ele
 * procura cobertura ou fecha a distância.
 */

import * as THREE from 'three';
import { Vitais } from './Vitals.js';

/** Teto do nível de alerta. */
const NIVEL_MAXIMO = 5;

/** Segundos sem infração antes de a suspeita começar a cair. */
const ESPERA_QUEDA = 9;

/** Níveis por segundo que a suspeita perde depois da carência. */
const QUEDA = 0.11;

/** Drones no ar por nível de alerta (índice = nível). */
const DRONES_POR_NIVEL = [0, 1, 2, 3, 5, 7];

/** Distância que o drone tenta manter do jogador. */
const DISTANCIA_COMBATE = 15;

/** Além disto ele fecha a distância; aquém, recua. */
const TOLERANCIA = 4;

/** Altura de voo acima do solo. */
const ALTURA_VOO = 6;

/** A que distância do jogador um drone novo entra em cena. */
const RAIO_CHEGADA = 70;

/** Segundos entre rajadas. */
const CADENCIA = 1.5;

/** Alcance máximo de tiro. */
const ALCANCE = 60;

/** Velocidade do projétil do drone. Usada também na mira preditiva. */
const VELOCIDADE_TIRO = 120;

const _dir = new THREE.Vector3();
const _up = new THREE.Vector3();
const _alvo = new THREE.Vector3();
const _lateral = new THREE.Vector3();
const _desejado = new THREE.Vector3();
const _anterior = new THREE.Vector3();

/**
 * Constrói o corpo de um drone a partir de primitivas.
 *
 * Não há modelo de drone no pacote e desenhar um em código é honesto aqui: a
 * silhueta que importa é "olho brilhante entre duas placas", que se resolve em
 * três primitivas e lê à distância exatamente como precisa ler.
 */
function corpoDeDrone() {
  const grupo = new THREE.Group();

  const casca = new THREE.MeshStandardMaterial({
    color: 0xb9c4cf,
    metalness: 0.85,
    roughness: 0.32,
  });
  const nucleo = new THREE.Mesh(new THREE.OctahedronGeometry(0.62, 0), casca);
  grupo.add(nucleo);

  for (const lado of [-1, 1]) {
    const placa = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.9, 0.62), casca);
    placa.position.x = lado * 0.72;
    grupo.add(placa);
  }

  // O olho é `MeshBasicMaterial` e não emissivo: precisa brilhar igual no lado
  // noturno do planeta, que é onde a sentinela mais assusta.
  const olho = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xff4a3a, toneMapped: false })
  );
  olho.position.z = -0.52;
  grupo.add(olho);

  grupo.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });

  return { grupo, olho, materiais: [casca, olho.material] };
}

export class Sentinelas {
  /**
   * @param {THREE.Scene} cena
   * @param {import('./Weapons.js').Projeteis} projeteis
   */
  constructor(cena, projeteis) {
    this.cena = cena;
    this.projeteis = projeteis;

    this.suspeita = 0;
    this._carencia = 0;

    /** @type {Array<object>} */
    this.drones = [];

    /** @type {Array<object>} reaproveitado por `alvos()`. */
    this._alvos = [];

    /** @type {((nivel: number, anterior: number) => void) | null} */
    this.aoMudarNivel = null;
    /** @type {((drone: object) => void) | null} */
    this.aoAbater = null;
  }

  get nivel() {
    return Math.min(NIVEL_MAXIMO, Math.floor(this.suspeita));
  }

  /** Fração dentro do nível atual — a interface desenha a estrela enchendo. */
  get progresso() {
    return this.suspeita - Math.floor(this.suspeita);
  }

  get ativas() {
    return this.drones.length;
  }

  /**
   * Registra algo que as sentinelas reprovam.
   *
   * O peso é o que separa arrancar uma pedra de abater uma criatura, e é
   * deliberadamente pequeno: o primeiro nível deve custar VÁRIAS infrações,
   * senão o jogador é punido por jogar.
   *
   * @param {number} peso
   */
  registrarInfracao(peso) {
    const antes = this.nivel;
    this.suspeita = Math.min(NIVEL_MAXIMO, this.suspeita + peso);
    this._carencia = ESPERA_QUEDA;
    const agora = this.nivel;
    if (agora !== antes) this.aoMudarNivel?.(agora, antes);
  }

  /** Zera tudo (salto, morte, entrada em sistema regulado). */
  limpar() {
    const antes = this.nivel;
    this.suspeita = 0;
    this._carencia = 0;
    for (const d of this.drones) this._destruir(d);
    this.drones.length = 0;
    if (antes !== 0) this.aoMudarNivel?.(0, antes);
  }

  /**
   * Drones atacáveis, em espaço de cena — mesmo contrato de `Fauna.alvos()`,
   * para que `Projeteis.atualizar` receba os dois na mesma lista sem saber a
   * diferença.
   */
  alvos() {
    this._alvos.length = 0;
    for (const d of this.drones) {
      if (!d.vitais.vivo) continue;
      d.slot.posicao.copy(d.grupo.position);
      this._alvos.push(d.slot);
    }
    return this._alvos;
  }

  /**
   * @param {number} dt
   * @param {import('../world/Planet.js').Planet} planeta
   * @param {THREE.Vector3} posJogador espaço de cena
   * @param {any} donoJogador identidade do jogador (não levar o próprio tiro)
   * @param {boolean} ativo o jogador está no planeta e jogando?
   */
  atualizar(dt, planeta, posJogador, donoJogador, ativo) {
    this._decair(dt);

    if (!ativo) {
      // Fora do planeta as sentinelas não somem — a suspeita continua caindo —
      // mas os drones sim: mantê-los voando num mundo que o jogador deixou
      // custaria física e desenho por ninguém.
      if (this.drones.length) {
        for (const d of this.drones) this._destruir(d);
        this.drones.length = 0;
      }
      return;
    }

    this._popular(planeta, posJogador);

    for (let i = this.drones.length - 1; i >= 0; i--) {
      const drone = this.drones[i];
      if (!drone.vitais.vivo) {
        this.aoAbater?.(drone);
        this._destruir(drone);
        this.drones.splice(i, 1);
        continue;
      }
      this._atualizarDrone(drone, dt, planeta, posJogador, donoJogador);
    }
  }

  _decair(dt) {
    if (this._carencia > 0) {
      this._carencia -= dt;
      return;
    }
    if (this.suspeita <= 0) return;

    const antes = this.nivel;
    this.suspeita = Math.max(0, this.suspeita - QUEDA * dt);
    const agora = this.nivel;
    if (agora !== antes) this.aoMudarNivel?.(agora, antes);
  }

  /** Cria ou remove drones para bater com o nível atual. */
  _popular(planeta, posJogador) {
    const desejado = DRONES_POR_NIVEL[this.nivel] ?? 0;

    while (this.drones.length > desejado) {
      // Retira o mais recente: os que já estão em combate com o jogador são os
      // mais antigos, e vê-los evaporar no meio da troca de tiros seria pior
      // que manter um a mais por alguns segundos.
      this._destruir(this.drones.pop());
    }

    while (this.drones.length < desejado) {
      this.drones.push(this._nascer(planeta, posJogador));
    }
  }

  _nascer(planeta, posJogador) {
    const { grupo, olho, materiais } = corpoDeDrone();

    // Entra num ponto ALTO e afastado, não ao lado do jogador: aparecer a três
    // metros lê como truque, e descer voando lê como resposta.
    const angulo = Math.random() * Math.PI * 2;
    const amostra = planeta.sampleAt(posJogador);
    _up.copy(amostra.direction);
    _lateral.set(-_up.y, _up.x, 0);
    if (_lateral.lengthSq() < 1e-6) _lateral.set(1, 0, 0);
    _lateral.normalize().applyAxisAngle(_up, angulo);

    grupo.position
      .copy(posJogador)
      .addScaledVector(_lateral, RAIO_CHEGADA)
      .addScaledVector(_up, 26);
    this.cena.add(grupo);

    const drone = {
      grupo,
      olho,
      materiais,
      vitais: new Vitais({ escudoMaximo: 34, vidaMaxima: 26 }),
      recarga: Math.random() * CADENCIA,
      // Fase própria para o bailado: sem ela todos os drones oscilariam em
      // uníssono e o enxame pareceria uma peça só.
      fase: Math.random() * Math.PI * 2,
      velocidade: new THREE.Vector3(),
      slot: { posicao: new THREE.Vector3(), raio: 1.0, vitais: null, drone: null, dono: null },
    };
    drone.slot.vitais = drone.vitais;
    drone.slot.drone = drone;
    // ---------------------------------------------------------------------
    // O `dono` NO SLOT É O QUE IMPEDE O DRONE DE ATIRAR EM SI MESMO.
    //
    // `Projeteis` pula o alvo cujo `dono` é o mesmo do tiro. Sem este campo ele
    // valia `undefined`, nunca casava com o drone atirador, e o projétil —
    // nascido exatamente na posição do drone — colidia com o próprio atirador
    // no primeiro passo de integração.
    //
    // O efeito era discreto e completamente enganoso: nenhum tiro chegava ao
    // jogador, o contador de projéteis vivos ficava sempre em zero, e o nível
    // de alerta subia sozinho até o máximo — porque levar dano é infração, e a
    // esquadrilha inteira estava se metralhando.
    // ---------------------------------------------------------------------
    drone.slot.dono = drone;

    // Levar tiro é infração: atirar numa sentinela é exatamente o tipo de coisa
    // que as sentinelas reprovam, e sem isto o jogador poderia limpar o céu sem
    // que o alerta jamais subisse.
    drone.vitais.aoLevarDano = () => this.registrarInfracao(0.12);

    return drone;
  }

  _destruir(drone) {
    drone.grupo.removeFromParent();
    drone.grupo.traverse((o) => {
      if (o.isMesh) o.geometry.dispose();
    });
    for (const m of drone.materiais) m.dispose();
  }

  _atualizarDrone(drone, dt, planeta, posJogador, donoJogador) {
    drone.vitais.atualizar(dt);
    drone.recarga -= dt;
    drone.fase += dt;

    const amostra = planeta.sampleAt(drone.grupo.position);
    _up.copy(amostra.direction);

    // --- Posição desejada --------------------------------------------------
    _dir.copy(drone.grupo.position).sub(posJogador);
    const distancia = _dir.length();
    if (distancia > 1e-4) _dir.divideScalar(distancia);
    else _dir.copy(_up);

    // Anel em torno do jogador, na altura de voo. O drone não busca um ponto
    // fixo: busca o ponto do anel mais próximo de onde ele já está, o que faz o
    // enxame se distribuir sozinho em vez de empilhar num lugar só.
    _desejado.copy(posJogador).addScaledVector(_dir, DISTANCIA_COMBATE);
    const solo = planeta.sampleAt(_desejado);
    _desejado
      .copy(solo.direction)
      .multiplyScalar(solo.surfaceRadius + ALTURA_VOO + Math.sin(drone.fase * 1.7) * 1.2)
      .add(planeta.group.position);

    // Só se move se estiver realmente fora da faixa: com a tolerância, um drone
    // na distância certa fica pairando em vez de tremer entre avançar e recuar.
    const erro = distancia - DISTANCIA_COMBATE;
    if (Math.abs(erro) > TOLERANCIA || drone.grupo.position.distanceTo(_desejado) > 3) {
      _anterior.copy(drone.grupo.position);
      drone.grupo.position.lerp(_desejado, Math.min(1, dt * 1.5));
      drone.velocidade.copy(drone.grupo.position).sub(_anterior).divideScalar(Math.max(dt, 1e-4));
    } else {
      drone.velocidade.multiplyScalar(Math.max(0, 1 - dt * 3));
    }

    // --- Orientação --------------------------------------------------------
    // Encara o jogador: o olho vermelho é a única pista de para onde o drone
    // está "olhando", e um drone que atira de lado não comunica ameaça.
    _alvo.copy(posJogador);
    drone.grupo.lookAt(_alvo);

    // --- Tiro --------------------------------------------------------------
    if (drone.recarga <= 0 && distancia < ALCANCE) {
      drone.recarga = CADENCIA;
      this.projeteis.disparar({
        origem: drone.grupo.position,
        direcao: _alvo.copy(posJogador).sub(drone.grupo.position).normalize(),
        velocidade: VELOCIDADE_TIRO,
        dano: 7,
        alcance: ALCANCE * 1.2,
        cor: 0xff5a3a,
        dono: drone,
        // O jogador entra na lista de alvos como qualquer outro (ver
        // `montarAlvos` em `main.js`), então o acerto nele é resolvido pelo
        // mesmo teste de segmento contra esfera que resolve o acerto num
        // drone. Nenhum caso especial, e portanto nenhuma chance de as duas
        // regras divergirem.
      });
    }
  }

  /**
   * Reage ao rebase da origem flutuante.
   *
   * Os drones guardam posição de CENA no próprio `grupo`, e não são filhos do
   * planeta — sem isto, cada recentragem os arremessaria a milhares de unidades
   * e o combate acabaria sozinho.
   *
   * @param {THREE.Vector3} delta
   */
  deslocar(delta) {
    for (const d of this.drones) d.grupo.position.sub(delta);
  }

  dispose() {
    for (const d of this.drones) this._destruir(d);
    this.drones.length = 0;
  }
}

export { NIVEL_MAXIMO, VELOCIDADE_TIRO };
