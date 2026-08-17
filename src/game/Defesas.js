/**
 * Defesas da base: torres e geradores de escudo.
 *
 * ===========================================================================
 * O QUE ELAS RESOLVEM QUE UMA PAREDE NÃO RESOLVE
 * ===========================================================================
 * Antes disto, a base era um objeto decorativo do ponto de vista do combate: as
 * sentinelas e os piratas existiam, mas nada do que o jogador construía tinha
 * qualquer relação com eles. Construir era um passatempo paralelo ao jogo, e não
 * uma jogada dentro dele.
 *
 * A torre muda isso porque ela transforma a base num LUGAR QUE DEFENDE — ou
 * seja, num motivo para voltar. O gerador de escudo muda porque introduz a
 * primeira decisão de arquitetura com consequência: onde pôr o gerador define o
 * que sobrevive a um ataque.
 *
 * ===========================================================================
 * A TORRE AVISA ANTES DE ATIRAR
 * ===========================================================================
 * Ela gira até apontar, e só atira quando está apontada. Isso não é um detalhe
 * de animação: é o que dá ao jogador (ou ao pirata) a batida de tempo para
 * reagir. Uma torre que acerta no instante em que você entra no alcance é
 * indistinguível de dano aleatório; uma que se vira primeiro é um oponente.
 *
 * É a mesma razão de os projéteis terem tempo de voo (ver `Weapons.js`): o que
 * torna um combate legível é haver um intervalo entre a intenção e o efeito.
 *
 * ===========================================================================
 * O ESCUDO É GEOMETRIA, NÃO UMA EXCEÇÃO NA REGRA DE DANO
 * ===========================================================================
 * A tentação é interceptar o dano: "se o alvo está dentro do raio de um gerador
 * vivo, redirecionar o golpe para o gerador". Isso criaria uma segunda regra de
 * acerto convivendo com a primeira — exatamente o que o comentário de
 * `montarAlvos` em `main.js` explica que se evitou para o jogador.
 *
 * Aqui o gerador simplesmente CONTRIBUI UM ALVO ESFÉRICO do tamanho da bolha. Um
 * tiro que vem de fora encosta na casca antes de alcançar qualquer coisa
 * abrigada, e o teste de segmento contra esfera que já existe faz o resto. Não há
 * caso especial: a bolha para o tiro porque ela está no caminho.
 *
 * O único acréscimo é a marca `casca`, que diz "só conta se o tiro vier de
 * fora". Sem ela a torre abrigada não conseguiria atirar para fora da própria
 * bolha, e o jogador ficaria preso atirando na sua própria proteção.
 */

import * as THREE from 'three';
import { Vitais } from './Vitals.js';
import { pontoDeIntercepcao } from './intercepcao.js';

/* ------------------------------------------------------------------------- */
/* Torre                                                                     */
/* ------------------------------------------------------------------------- */

/** Até onde a torre enxerga. */
const ALCANCE = 150;

/** Segundos entre tiros. */
const CADENCIA = 0.55;

const DANO = 15;

/** Velocidade do projétil da torre. */
const VELOCIDADE_TIRO = 320;

/**
 * Quão rápido a torre gira, em radianos por segundo.
 *
 * ~1,8 rad/s dá pouco menos de um terço de volta por segundo: rápido o bastante
 * para acompanhar um pirata em órbita, lento o bastante para que atravessar o
 * campo de tiro correndo seja uma tática e não um detalhe.
 */
const VELOCIDADE_GIRO = 1.8;

/**
 * Erro angular máximo para disparar, em radianos.
 *
 * Sem esta tolerância a torre atiraria durante o giro e a maioria dos tiros
 * sairia para o lado — o que na tela lê como uma arma quebrada, não como uma
 * arma errando.
 */
const TOLERANCIA_MIRA = 0.09;

/**
 * Altura da cabeça acima do pé da torre — apenas RESERVA.
 *
 * O valor real vem medido da peça de construção que serve de pedestal (ver
 * `sincronizar`), porque só ela sabe o quanto o modelo tem de altura. Este número
 * cobre o caso de a medida não chegar, e existe para a torre nascer torta em vez
 * de nascer com a cabeça enterrada no chão.
 */
const ALTURA_BOCA = 1.35;

/* ------------------------------------------------------------------------- */
/* Gerador de escudo                                                         */
/* ------------------------------------------------------------------------- */

/** Raio da bolha, em unidades de mundo. */
const RAIO_BOLHA = 26;

/**
 * Segundos que a bolha fica caída depois de o escudo zerar.
 *
 * O gerador não volta no instante em que o escudo começa a regenerar: se
 * voltasse, derrubá-lo não teria consequência nenhuma e o atacante ficaria preso
 * num ciclo de quebrar a mesma casca para sempre. A janela é a recompensa de
 * quem derrubou.
 */
const ESPERA_RELIGAR = 12;

const _dir = new THREE.Vector3();
const _mira = new THREE.Vector3();
const _boca = new THREE.Vector3();
const _local = new THREE.Vector3();
const _eixo = new THREE.Vector3();
const _quatAlvo = new THREE.Quaternion();
const _zero = new THREE.Vector3();

/**
 * Corpo da torre: só a CABEÇA.
 *
 * O pedestal não está aqui, e a razão é mecânica antes de ser estética. A base
 * da torre é uma peça de construção comum (um pilar do kit), desenhada pelo
 * `InstancedMesh` do `BuildSystem` junto com o resto da base — ela ganha de
 * graça a animação de surgimento, a demolição e o custo em recursos.
 *
 * A cabeça é o que sobra: ela GIRA, e por isso jamais poderia ser uma instância
 * dentro de uma malha estática. Dividir assim significa que só a parte que
 * precisa de arte nova tem arte nova, e o resto continua parecendo ter saído do
 * mesmo kit que a base.
 *
 * @param {number} cor cor do olho
 * @param {number} altura onde a cabeça se apoia, medida do pé da peça
 */
function corpoDeTorre(cor, altura) {
  const grupo = new THREE.Group();
  const materiais = [];

  const metal = new THREE.MeshStandardMaterial({ color: 0x8a9099, metalness: 0.7, roughness: 0.45 });
  const escuro = new THREE.MeshStandardMaterial({ color: 0x3c424b, metalness: 0.6, roughness: 0.6 });
  materiais.push(metal, escuro);

  // A cabeça é um grupo à parte: é ela que recebe o giro e a elevação.
  const cabeca = new THREE.Group();
  cabeca.position.y = altura;
  grupo.add(cabeca);

  const carcaca = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.62, 1.0), metal);
  carcaca.castShadow = true;
  cabeca.add(carcaca);

  for (const lado of [-0.26, 0.26]) {
    const cano = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.095, 1.4, 8), escuro);
    cano.rotation.x = Math.PI / 2;
    cano.position.set(lado, 0.02, -0.78);
    cabeca.add(cano);
  }

  // O olho acende: é o que diz de longe se a torre está viva e de que lado ela
  // está olhando. `MeshBasicMaterial` para não depender da luz do sol.
  const brilhoMat = new THREE.MeshBasicMaterial({ color: cor, toneMapped: false });
  materiais.push(brilhoMat);
  const olho = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), brilhoMat);
  olho.position.set(0, 0.2, -0.44);
  cabeca.add(olho);

  return { grupo, cabeca, materiais, brilhoMat };
}

/** Casca do gerador de escudo. */
function corpoDeBolha(cor) {
  const material = new THREE.MeshBasicMaterial({
    color: cor,
    transparent: true,
    opacity: 0.13,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const malha = new THREE.Mesh(new THREE.SphereGeometry(RAIO_BOLHA, 32, 24), material);
  // Depois do terreno e do oceano, antes das nuvens: a bolha é um efeito e não
  // deve tapar a atmosfera.
  malha.renderOrder = 2;
  return { malha, material };
}

export class Defesas {
  /**
   * @param {THREE.Scene} cena
   * @param {import('./Weapons.js').Projeteis} projeteis
   */
  constructor(cena, projeteis) {
    this.cena = cena;
    this.projeteis = projeteis;

    /** @type {Map<string, object>} torres vivas, por chave da peça */
    this.torres = new Map();
    /** @type {Map<string, object>} geradores vivos, por chave da peça */
    this.geradores = new Map();

    /**
     * Quem a torre considera inimigo.
     *
     * Injetado porque a resposta não é do módulo: hoje são drones e piratas,
     * amanhã pode ser um jogador de outro grupo num sistema anárquico. A torre
     * só precisa saber que existe uma pergunta a fazer.
     * @type {(alvo: object) => boolean}
     */
    this.ehHostil = () => false;

    /** @type {Array<object>} reaproveitado por `alvos()`. */
    this._alvos = [];

    /** @type {((torre: object) => void) | null} */
    this.aoDispararTorre = null;
    /** @type {((gerador: object) => void) | null} */
    this.aoCairEscudo = null;
  }

  get temDefesa() {
    return this.torres.size > 0 || this.geradores.size > 0;
  }

  /* ===================================================================== */
  /* Sincronização com as peças construídas                                */
  /* ===================================================================== */

  /**
   * Alinha as defesas vivas com a lista de peças que existem agora.
   *
   * ---------------------------------------------------------------------
   * POR QUE SINCRONIZAR EM VEZ DE OUVIR EVENTOS
   * ---------------------------------------------------------------------
   * Uma peça pode entrar por três caminhos diferentes: o jogador construindo, a
   * rede replicando o que outro construiu, e o banco restaurando a base ao
   * entrar na sala. Um `aoColocar` teria de ser disparado corretamente nos três,
   * e o dia em que um deles esquecesse de chamá-lo a torre simplesmente não
   * existiria — sem erro, sem sintoma, até alguém ser atacado.
   *
   * Comparar com a lista autoritativa não tem esse modo de falha: qualquer
   * caminho que ponha a peça no mapa ganha a defesa no quadro seguinte.
   *
   * @param {Array<{chave:string, tipo:string, posicao:THREE.Vector3, quat:THREE.Quaternion, cor?:number}>} pecas
   */
  sincronizar(pecas) {
    const vistas = new Set();

    for (const p of pecas) {
      vistas.add(p.chave);

      if (p.tipo === 'torre') {
        const existente = this.torres.get(p.chave);
        if (existente) {
          existente.grupo.position.copy(p.posicao);
          existente.grupo.quaternion.copy(p.quat);
          continue;
        }
        this.torres.set(p.chave, this._nascerTorre(p));
      } else if (p.tipo === 'gerador-escudo') {
        const existente = this.geradores.get(p.chave);
        if (existente) {
          existente.grupo.position.copy(p.posicao);
          existente.grupo.quaternion.copy(p.quat);
          existente.bolha.position.copy(p.posicao);
          continue;
        }
        this.geradores.set(p.chave, this._nascerGerador(p));
      }
    }

    // Peça demolida (ou base descartada) leva a defesa junto.
    for (const [chave, torre] of this.torres) {
      if (vistas.has(chave)) continue;
      this._destruirTorre(torre);
      this.torres.delete(chave);
    }
    for (const [chave, gerador] of this.geradores) {
      if (vistas.has(chave)) continue;
      this._destruirGerador(gerador);
      this.geradores.delete(chave);
    }
  }

  _nascerTorre(p) {
    const altura = p.altura ?? ALTURA_BOCA;
    const { grupo, cabeca, materiais, brilhoMat } = corpoDeTorre(p.cor ?? 0x7ad9ff, altura);
    grupo.position.copy(p.posicao);
    grupo.quaternion.copy(p.quat);
    this.cena.add(grupo);

    const torre = {
      grupo,
      cabeca,
      materiais,
      brilhoMat,
      altura,
      vitais: new Vitais({ escudoMaximo: 120, vidaMaxima: 160 }),
      recarga: Math.random() * CADENCIA,
      // Fase da varredura em repouso, para duas torres vizinhas não girarem em
      // sincronia como se fossem uma peça só.
      fase: Math.random() * Math.PI * 2,
      alvo: null,
      slot: {
        posicao: new THREE.Vector3(),
        velocidade: new THREE.Vector3(),
        raio: 1.1,
        vitais: null,
        dono: null,
        torre: null,
      },
    };
    torre.slot.vitais = torre.vitais;
    torre.slot.dono = torre;
    torre.slot.torre = torre;
    return torre;
  }

  _nascerGerador(p) {
    // Grupo sem malha: a carcaça do gerador é uma peça de construção comum,
    // desenhada pelo `BuildSystem`. O que este módulo possui é a BOLHA. O grupo
    // vazio existe só para a posição e a orientação serem tratadas do mesmo modo
    // que nas torres, e para o deslocamento da origem flutuante não precisar de
    // dois caminhos.
    const grupo = new THREE.Group();
    grupo.position.copy(p.posicao);
    grupo.quaternion.copy(p.quat);
    this.cena.add(grupo);

    const { malha, material } = corpoDeBolha(p.cor ?? 0x8ad4ff);
    malha.position.copy(p.posicao);
    this.cena.add(malha);

    const gerador = {
      grupo,
      bolha: malha,
      bolhaMat: material,
      // Escudo grande e blindagem pequena: o gerador é feito para absorver, não
      // para aguentar. Quem chega até a carcaça já venceu a bolha.
      vitais: new Vitais({ escudoMaximo: 420, vidaMaxima: 130 }),
      religarEm: 0,
      fase: Math.random() * Math.PI * 2,
      /** Alvo da CARCAÇA: pequeno, e só alcançável com a bolha caída. */
      slotCorpo: {
        posicao: new THREE.Vector3(),
        velocidade: new THREE.Vector3(),
        raio: 1.0,
        vitais: null,
        dono: null,
        gerador: null,
      },
      /** Alvo da BOLHA: grande, e só conta para quem atira de fora. */
      slotBolha: {
        posicao: new THREE.Vector3(),
        velocidade: new THREE.Vector3(),
        raio: RAIO_BOLHA,
        casca: true,
        vitais: null,
        dono: null,
        gerador: null,
      },
    };
    gerador.slotCorpo.vitais = gerador.vitais;
    gerador.slotCorpo.dono = gerador;
    gerador.slotCorpo.gerador = gerador;
    gerador.slotBolha.vitais = gerador.vitais;
    gerador.slotBolha.dono = gerador;
    gerador.slotBolha.gerador = gerador;
    return gerador;
  }

  _destruirTorre(torre) {
    torre.grupo.removeFromParent();
    torre.grupo.traverse((o) => {
      if (o.isMesh) o.geometry.dispose();
    });
    for (const m of torre.materiais) m.dispose();
  }

  _destruirGerador(gerador) {
    gerador.grupo.removeFromParent();
    gerador.bolha.removeFromParent();
    gerador.bolha.geometry.dispose();
    gerador.bolhaMat.dispose();
  }

  /* ===================================================================== */
  /* Alvos                                                                 */
  /* ===================================================================== */

  /**
   * O que pode ser atingido, no mesmo contrato de `Sentinelas.alvos()`.
   *
   * A bolha entra ANTES da carcaça na lista, e isso é de propósito: `Projeteis`
   * devolve o primeiro alvo que o segmento cruza, e em caso de empate a ordem
   * decide. A casca precisa vencer.
   */
  alvos() {
    this._alvos.length = 0;

    for (const gerador of this.geradores.values()) {
      if (!gerador.vitais.vivo) continue;
      if (this._bolhaDePe(gerador)) {
        gerador.slotBolha.posicao.copy(gerador.bolha.position);
        this._alvos.push(gerador.slotBolha);
      }
      gerador.slotCorpo.posicao.copy(gerador.grupo.position);
      this._alvos.push(gerador.slotCorpo);
    }

    for (const torre of this.torres.values()) {
      if (!torre.vitais.vivo) continue;
      // O alvo é a CABEÇA, não o pé do pedestal: atirar na torre e o tiro passar
      // um metro abaixo dela, no pilar, seria uma discordância entre o que se vê
      // e o que se acerta.
      torre.cabeca.getWorldPosition(torre.slot.posicao);
      this._alvos.push(torre.slot);
    }

    return this._alvos;
  }

  /** A bolha está protegendo agora? */
  _bolhaDePe(gerador) {
    return gerador.religarEm <= 0 && gerador.vitais.escudo > 0;
  }

  /* ===================================================================== */
  /* Passo                                                                 */
  /* ===================================================================== */

  /**
   * @param {number} dt
   * @param {Array<object>} candidatos alvos do quadro (ver `montarAlvos`)
   */
  atualizar(dt, candidatos) {
    for (const [chave, gerador] of this.geradores) {
      this._atualizarGerador(gerador, dt);
      if (!gerador.vitais.vivo) {
        this._destruirGerador(gerador);
        this.geradores.delete(chave);
      }
    }

    for (const [chave, torre] of this.torres) {
      this._atualizarTorre(torre, dt, candidatos);
      if (!torre.vitais.vivo) {
        this._destruirTorre(torre);
        this.torres.delete(chave);
      }
    }
  }

  _atualizarGerador(gerador, dt) {
    gerador.vitais.atualizar(dt);
    gerador.fase += dt;

    if (gerador.religarEm > 0) gerador.religarEm -= dt;

    // O escudo caindo derruba a bolha e abre a janela de vulnerabilidade.
    if (gerador.religarEm <= 0 && gerador.vitais.escudo <= 0) {
      gerador.religarEm = ESPERA_RELIGAR;
      this.aoCairEscudo?.(gerador);
    }

    const dePe = this._bolhaDePe(gerador);
    gerador.bolha.visible = dePe;
    if (dePe) {
      // A opacidade acompanha a carga: uma bolha quase vazia é visivelmente mais
      // fina, o que informa o defensor sem precisar de número na tela.
      const carga = gerador.vitais.razaoEscudo;
      gerador.bolhaMat.opacity = 0.06 + 0.1 * carga + Math.sin(gerador.fase * 2.1) * 0.012;
    }
  }

  _atualizarTorre(torre, dt, candidatos) {
    torre.vitais.atualizar(dt);
    torre.fase += dt;
    if (torre.recarga > 0) torre.recarga -= dt;

    const alvo = this._escolherAlvo(torre, candidatos);
    torre.alvo = alvo;

    // O olho apaga quando o escudo cai: um sinal barato de que a torre está mal.
    torre.brilhoMat.color.setHex(torre.vitais.escudo > 0 ? 0x7ad9ff : 0xff7a5a);

    if (!alvo) {
      // Em repouso, varre devagar. Uma torre imóvel parece um poste.
      _quatAlvo.setFromAxisAngle(_eixo.set(0, 1, 0), Math.sin(torre.fase * 0.25) * 0.9);
      torre.cabeca.quaternion.slerp(_quatAlvo, Math.min(1, dt * 1.2));
      return;
    }

    // ---------------------------------------------------------------------
    // A MIRA É PREDITIVA, igual à da nave e à dos piratas.
    //
    // Sem antecipação a torre erraria todo alvo em movimento, que num ataque é
    // a totalidade deles — e "a torre não acerta nada" é indistinguível de "a
    // torre está quebrada".
    // ---------------------------------------------------------------------
    this._posicaoDaBoca(torre, _boca);
    if (!pontoDeIntercepcao(_mira, _boca, alvo.posicao, alvo.velocidade ?? _zero, VELOCIDADE_TIRO)) {
      return; // alvo rápido demais: não há solução, e apontar para o nada é pior
    }

    // Gira a cabeça em direção ao ponto de mira, no espaço LOCAL da torre — é o
    // grupo dela que carrega a orientação de "para cima" no planeta.
    _local.copy(_mira);
    torre.grupo.worldToLocal(_local);
    _local.y -= torre.altura;

    const alcance = _local.length();
    if (alcance < 1e-4) return;
    _dir.copy(_local).divideScalar(alcance);

    // `-Z` é a frente dos canos (ver `corpoDeTorre`).
    _quatAlvo.setFromUnitVectors(_eixo.set(0, 0, -1), _dir);
    torre.cabeca.quaternion.slerp(_quatAlvo, Math.min(1, VELOCIDADE_GIRO * dt));

    if (torre.recarga > 0) return;

    // Só atira apontada. Ver TOLERANCIA_MIRA.
    const erro = torre.cabeca.quaternion.angleTo(_quatAlvo);
    if (erro > TOLERANCIA_MIRA) return;

    torre.recarga = CADENCIA;
    this.projeteis.disparar({
      origem: _boca,
      direcao: _mira.sub(_boca).normalize(),
      velocidade: VELOCIDADE_TIRO,
      dano: DANO,
      alcance: ALCANCE * 1.3,
      cor: 0x9effc8,
      dono: torre,
    });
    this.aoDispararTorre?.(torre);
  }

  /**
   * O alvo hostil mais próximo dentro do alcance.
   *
   * Aqui o critério é DISTÂNCIA, e não alinhamento como nos canhões da nave: a
   * torre não tem frente — ela gira. O que ela quer é a ameaça mais perto do que
   * está protegendo.
   */
  _escolherAlvo(torre, candidatos) {
    let melhor = null;
    let melhorDist = ALCANCE * ALCANCE;

    for (const alvo of candidatos) {
      if (alvo.dono === torre) continue;
      if (alvo.vitais && !alvo.vitais.vivo) continue;
      if (!this.ehHostil(alvo)) continue;

      const d = _dir.copy(alvo.posicao).sub(torre.grupo.position).lengthSq();
      if (d < melhorDist) {
        melhorDist = d;
        melhor = alvo;
      }
    }
    return melhor;
  }

  _posicaoDaBoca(torre, saida) {
    saida.set(0, 0, -1.2).applyQuaternion(torre.cabeca.quaternion);
    saida.y += torre.altura;
    return torre.grupo.localToWorld(saida);
  }

  /* ===================================================================== */
  /* Limpeza                                                               */
  /* ===================================================================== */

  // -----------------------------------------------------------------------
  // NÃO EXISTE `deslocar()` AQUI, ao contrário de `Piratas` e `Sentinelas`.
  //
  // Aqueles dois têm posição própria: ninguém além deles sabe onde estão, então
  // um rebase da origem flutuante precisa ser repassado. As defesas não têm
  // posição própria — a posição delas é uma FUNÇÃO da peça construída, e
  // `sincronizar` a recalcula do mundo a cada quadro.
  //
  // Somar o delta aqui seria aplicá-lo duas vezes: uma na mão e outra na
  // sincronização do quadro seguinte, que sobrescreve tudo de qualquer forma.
  // -----------------------------------------------------------------------

  limpar() {
    for (const t of this.torres.values()) this._destruirTorre(t);
    for (const g of this.geradores.values()) this._destruirGerador(g);
    this.torres.clear();
    this.geradores.clear();
  }

  dispose() {
    this.limpar();
  }
}

export { RAIO_BOLHA, ALCANCE as ALCANCE_TORRE };
