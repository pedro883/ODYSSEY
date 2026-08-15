/**
 * Piratas espaciais: emboscada com carga valiosa ou ao sair de um salto.
 *
 * ===========================================================================
 * O QUE ELES ACRESCENTAM QUE SENTINELA NÃO ACRESCENTA
 * ===========================================================================
 * A sentinela é uma ameaça de SUPERFÍCIE, provocada por extrair e abater, e o
 * jogador a enfrenta a pé ou pousado. O pirata é a ameaça do ESPAÇO, provocada
 * por ter algo que valha a pena roubar — e ele existe para dar função ao
 * armamento da nave, que sem inimigo é decoração.
 *
 * Os dois gatilhos são deliberadamente diferentes em caráter:
 *
 *   - CARGA VALIOSA é uma consequência que o jogador escolhe correr. Minerar
 *     muito e voar carregado passa a ter risco, e largar a carga passa a ser
 *     uma decisão. Sem isso, encher o porão é sempre gratuito.
 *   - SAÍDA DE SALTO é surpresa pura, e por isso é rara. Ela existe para que o
 *     espaço não vire seguro só porque o porão está vazio.
 *
 * ===========================================================================
 * POR QUE ELES REAPROVEITAM A NAVE DO JOGADOR
 * ===========================================================================
 * Não é economia de arte — é leitura. O jogador já sabe o que aquela silhueta
 * faz: ela voa, vira e atira. Um modelo novo exigiria ensinar tudo de novo, e a
 * pintura escura mais o brilho vermelho do motor bastam para dizer de que lado
 * ela está.
 */

import * as THREE from 'three';
import { Vitais } from './Vitals.js';

/** Quantos piratas por emboscada, por nível de ameaça. */
const POR_NIVEL = [0, 2, 3];

/** Valor de carga que atrai a primeira emboscada. */
const CARGA_PERIGOSA = 320;

/** Segundos entre emboscadas, no mínimo. */
const CARENCIA = 90;

/** Distância em que eles entram em cena. */
const RAIO_CHEGADA = 900;

/** Distância que tentam manter — dogfight, não abordagem. */
const DISTANCIA_COMBATE = 220;

/** Segundos entre rajadas. */
const CADENCIA = 1.1;

/** Velocidade do projétil do pirata. */
const VELOCIDADE_TIRO = 380;

const _dir = new THREE.Vector3();
const _up = new THREE.Vector3();
const _lateral = new THREE.Vector3();
const _desejado = new THREE.Vector3();
const _mira = new THREE.Vector3();
const _anterior = new THREE.Vector3();

/**
 * Casco pirata a partir do modelo da nave do jogador.
 *
 * O modelo é clonado e repintado; se ele ainda não carregou, cai numa silhueta
 * de primitivas em vez de não aparecer nada — uma emboscada invisível seria
 * pior que uma emboscada feia.
 */
function corpoDePirata(modeloBase) {
  const grupo = new THREE.Group();
  const materiais = [];

  const casco = new THREE.MeshStandardMaterial({
    color: 0x3a3f47,
    metalness: 0.8,
    roughness: 0.45,
  });
  materiais.push(casco);

  if (modeloBase) {
    const clone = modeloBase.clone(true);
    clone.traverse((o) => {
      if (o.isMesh) {
        o.material = casco;
        o.castShadow = true;
      }
    });
    grupo.add(clone);
  } else {
    const corpo = new THREE.Mesh(new THREE.ConeGeometry(0.7, 3.6, 8), casco);
    corpo.rotation.x = -Math.PI / 2;
    grupo.add(corpo);
    const asa = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.12, 1.0), casco);
    grupo.add(asa);
  }

  // O brilho do motor é `MeshBasicMaterial`: precisa acender igual no escuro do
  // espaço, que é onde a emboscada acontece.
  const brilho = new THREE.MeshBasicMaterial({ color: 0xff4a3a, toneMapped: false });
  materiais.push(brilho);
  const motor = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), brilho);
  motor.position.z = 1.8;
  grupo.add(motor);

  return { grupo, materiais };
}

export class Piratas {
  /**
   * @param {THREE.Scene} cena
   * @param {import('./Weapons.js').Projeteis} projeteis
   */
  constructor(cena, projeteis) {
    this.cena = cena;
    this.projeteis = projeteis;
    /**
     * Fonte do casco, consultada na hora de nascer.
     *
     * Função e não referência: no boot os assets ainda não chegaram, e guardar
     * `null` ali deixaria toda emboscada da sessão com a silhueta de reserva.
     * @type {(() => object|null) | null}
     */
    this.pegarModelo = null;

    /** @type {Array<object>} */
    this.naves = [];
    this._carencia = 0;
    this.emboscadas = 0;

    /** @type {Array<object>} reaproveitado por `alvos()`. */
    this._alvos = [];

    /** @type {((quantos: number, motivo: string) => void) | null} */
    this.aoEmboscar = null;
    /** @type {((nave: object) => void) | null} */
    this.aoAbater = null;
  }

  get ativos() {
    return this.naves.length;
  }

  get emCombate() {
    return this.naves.length > 0;
  }

  /**
   * Decide se uma emboscada começa agora.
   *
   * @param {number} valorDaCarga unidades que o porão vale
   * @param {boolean} recemSaltou o jogador acabou de chegar de um salto?
   * @returns {boolean}
   */
  talvezEmboscar(valorDaCarga, recemSaltou) {
    if (this._carencia > 0 || this.naves.length) return false;

    // A carga é o gatilho principal; o salto é o tempero raro. Sortear o salto
    // com probabilidade baixa evita que viajar vire uma sucessão de brigas.
    const porCarga = valorDaCarga >= CARGA_PERIGOSA;
    const porSalto = recemSaltou && Math.random() < 0.22;
    if (!porCarga && !porSalto) return false;

    // O nível cresce com a carga: quem voa com o porão cheio atrai mais gente.
    const nivel = valorDaCarga >= CARGA_PERIGOSA * 2.5 ? 2 : 1;
    this._pendente = { quantos: POR_NIVEL[nivel], motivo: porCarga ? 'carga' : 'salto' };
    return true;
  }

  /**
   * Alvos atacáveis, no mesmo contrato de `Fauna.alvos()` e `Sentinelas.alvos()`.
   *
   * A `velocidade` entra no slot porque a mira preditiva dos canhões precisa
   * dela — é o que torna o dogfight uma questão de antecipar, e não de apontar.
   */
  alvos() {
    this._alvos.length = 0;
    for (const nave of this.naves) {
      if (!nave.vitais.vivo) continue;
      nave.slot.posicao.copy(nave.grupo.position);
      nave.slot.velocidade.copy(nave.velocidade);
      this._alvos.push(nave.slot);
    }
    return this._alvos;
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} posJogador
   * @param {THREE.Vector3} velJogador
   * @param {any} donoJogador
   * @param {boolean} noEspaco emboscada só acontece fora da atmosfera
   */
  atualizar(dt, posJogador, velJogador, donoJogador, noEspaco) {
    if (this._carencia > 0) this._carencia -= dt;

    if (this._pendente && noEspaco) {
      const { quantos, motivo } = this._pendente;
      this._pendente = null;
      this._carencia = CARENCIA;
      this.emboscadas++;
      for (let i = 0; i < quantos; i++) this.naves.push(this._nascer(posJogador, i, quantos));
      this.aoEmboscar?.(quantos, motivo);
    }

    // Entrar na atmosfera encerra a perseguição: eles não descem. É a saída que
    // o jogador tem, e é o que impede a emboscada de virar um beco sem saída.
    if (!noEspaco && this.naves.length) {
      this.limpar();
      return;
    }

    for (let i = this.naves.length - 1; i >= 0; i--) {
      const nave = this.naves[i];
      if (!nave.vitais.vivo) {
        this.aoAbater?.(nave);
        this._destruir(nave);
        this.naves.splice(i, 1);
        continue;
      }
      this._atualizarNave(nave, dt, posJogador, velJogador, donoJogador);
    }
  }

  _nascer(posJogador, indice, total) {
    const { grupo, materiais } = corpoDePirata(this.pegarModelo?.() ?? null);

    // Em formação, e não empilhados: um leque em torno da direção de chegada.
    const angulo = (indice / Math.max(1, total)) * Math.PI * 2;
    _up.set(0, 1, 0);
    _lateral.set(Math.cos(angulo), 0, Math.sin(angulo));
    grupo.position
      .copy(posJogador)
      .addScaledVector(_lateral, RAIO_CHEGADA)
      .addScaledVector(_up, (indice - total / 2) * 60);
    this.cena.add(grupo);

    const nave = {
      grupo,
      materiais,
      vitais: new Vitais({ escudoMaximo: 90, vidaMaxima: 70 }),
      recarga: Math.random() * CADENCIA,
      fase: Math.random() * Math.PI * 2,
      velocidade: new THREE.Vector3(),
      slot: {
        posicao: new THREE.Vector3(),
        velocidade: new THREE.Vector3(),
        raio: 2.6,
        vitais: null,
        dono: null,
        pirata: null,
      },
    };
    nave.slot.vitais = nave.vitais;
    nave.slot.dono = nave;
    nave.slot.pirata = nave;
    return nave;
  }

  _destruir(nave) {
    nave.grupo.removeFromParent();
    nave.grupo.traverse((o) => {
      if (o.isMesh) o.geometry.dispose();
    });
    for (const m of nave.materiais) m.dispose();
  }

  _atualizarNave(nave, dt, posJogador, velJogador, donoJogador) {
    nave.vitais.atualizar(dt);
    nave.recarga -= dt;
    nave.fase += dt;

    _dir.copy(nave.grupo.position).sub(posJogador);
    const distancia = _dir.length();
    if (distancia > 1e-4) _dir.divideScalar(distancia);

    // Anel em torno do jogador, com uma oscilação por nave para que a formação
    // não vire uma parede parada.
    _desejado
      .copy(posJogador)
      .addScaledVector(_dir, DISTANCIA_COMBATE + Math.sin(nave.fase * 0.7) * 40);

    _anterior.copy(nave.grupo.position);
    nave.grupo.position.lerp(_desejado, Math.min(1, dt * 0.6));
    nave.velocidade.copy(nave.grupo.position).sub(_anterior).divideScalar(Math.max(dt, 1e-4));

    nave.grupo.lookAt(posJogador);

    if (nave.recarga > 0 || distancia > DISTANCIA_COMBATE * 2.5) return;
    nave.recarga = CADENCIA;

    // ---------------------------------------------------------------------
    // ELES TAMBÉM ANTECIPAM.
    //
    // Mirar na posição atual do jogador erraria sempre que ele estivesse em
    // movimento — que é sempre, num dogfight. A conta é a mesma do canhão do
    // jogador (ver `CanhoesDaNave._tempoDeIntercepcao`), simplificada: uma
    // estimativa de tempo por distância basta, porque a intenção aqui não é
    // acertar todo tiro, e sim obrigar o jogador a manobrar.
    // ---------------------------------------------------------------------
    const t = distancia / VELOCIDADE_TIRO;
    _mira.copy(posJogador).addScaledVector(velJogador, t);

    this.projeteis.disparar({
      origem: nave.grupo.position,
      direcao: _mira.sub(nave.grupo.position).normalize(),
      velocidade: VELOCIDADE_TIRO,
      dano: 9,
      alcance: DISTANCIA_COMBATE * 3,
      cor: 0xff6a4a,
      dono: nave,
      velocidadeBase: nave.velocidade,
    });
  }

  deslocar(delta) {
    for (const n of this.naves) n.grupo.position.sub(delta);
  }

  limpar() {
    for (const n of this.naves) this._destruir(n);
    this.naves.length = 0;
  }

  dispose() {
    this.limpar();
  }
}
