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
import { Vitais } from '../game/Vitals.js';

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

/**
 * A que distância um predador NOTA o jogador.
 *
 * Maior que o raio de fuga de propósito: o herbívoro só reage quando o jogador
 * quase encosta, o predador decide bem antes. É o que faz um encontro hostil
 * parecer uma caçada em vez de um susto.
 */
const RAIO_DETECCAO = 34;

/**
 * A que distância ele desiste.
 *
 * MAIOR que o de detecção, e a diferença é o que impede a criatura de piscar
 * entre perseguir e passear quando o jogador anda exatamente na fronteira —
 * histerese, o mesmo motivo pelo qual um termostato tem duas temperaturas.
 */
const RAIO_DESISTIR = 58;

/** Distância em que a mordida acerta. */
const ALCANCE_ATAQUE = 2.6;

/** Multiplicador de velocidade na perseguição. */
const CHASE_SPEED = 2.8;

/**
 * Segundos perseguindo depois de perder o jogador de vista.
 *
 * Sem esta memória, sair do raio por um instante (pular uma pedra, contornar
 * uma árvore) zeraria a perseguição na hora e nenhum predador jamais alcançaria
 * ninguém.
 */
const MEMORIA_CACADA = 4;

/** Segundos que uma criatura dócil permanece hostil depois de levar tiro. */
const IRRITACAO = 18;

/**
 * Raio de perseguição de quem foi baleado.
 *
 * Bem maior que o de detecção, e ainda assim MUITO menor que o alcance do
 * blaster (400): abater de longe continua sendo uma tática válida, só deixa de
 * ser gratuita quando se erra o primeiro tiro.
 */
const RAIO_IRRITADA = 120;

const BASE_SPEED = 3.2;

const _up = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _away = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _yawQuat = new THREE.Quaternion();
const _delta = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);
/** Temporário exclusivo de `alvos()`: `_up` é usado por `_updateCreature`. */
const _alvoCima = new THREE.Vector3();
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

    /**
     * Avisado quando um predador acerta uma mordida.
     *
     * O dano NÃO é aplicado aqui. Quem sabe o que é o jogador — e se ele está a
     * pé, dentro da nave ou dentro de uma base — é o laço principal. A fauna só
     * informa que acertou e com quanto. É a mesma separação que mantém `Vitais`
     * sem saber o que é um jogador.
     *
     * @type {((dano: number, criatura: object) => void) | null}
     */
    this.aoAtacar = null;

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

  /** Criaturas caçando o jogador neste instante — a interface avisa o perigo. */
  get cacando() {
    let n = 0;
    for (const c of this.creatures) if (c.cacada > 0) n++;
    return n;
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
  update(dt, reference, altitude, fatorDia = 1) {
    if (!this._ready) return;

    // Noite = sol abaixo do horizonte. O limiar é generoso (0,25 e não 0) para
    // que as criaturas noturnas apareçam junto com o crepúsculo, e não num
    // instante exato em que o mundo já está escuro há minutos.
    // Recalculado só na VIRADA, não a cada quadro: `filter` aloca um array, e
    // sessenta arrays por segundo jogados fora é exatamente o tipo de lixo que
    // acorda o coletor no meio do jogo.
    const noite = fatorDia < 0.25;
    if (noite !== this._noite || !this._elegiveis) {
      this._noite = noite;
      this._elegiveis = noite ? this.species : this.species.filter((e) => !e.noturno);
    }

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
      // ---------------------------------------------------------------------
      // A POSIÇÃO PRECISA VIRAR MUNDO ANTES DA COMPARAÇÃO.
      //
      // `object.position` é LOCAL ao grupo do planeta e `reference` é de cena.
      // Os dois coincidem enquanto o planeta está na origem — que é o caso no
      // primeiro minuto de jogo, e por isso o defeito passou despercebido. Ao
      // primeiro rebase da origem flutuante o grupo do planeta ganha um
      // deslocamento de milhares de unidades, a distância medida estoura o
      // `DESPAWN` para TODA criatura, e a fauna some do planeta inteiro no
      // quadro seguinte ao nascimento.
      //
      // O sintoma era "não tem bicho nenhum neste mundo", com o contador em
      // zero e nenhum erro no console. `_updateCreature` já fazia a conversão
      // certa logo abaixo; só esta linha ficou para trás.
      // ---------------------------------------------------------------------
      _delta.copy(criatura.object.position).add(this.planet.group.position);
      if (_delta.distanceTo(reference) > DESPAWN) {
        this._remove(i);
        continue;
      }
      // Abatida: sai no mesmo lugar em que a distância a tira. Some na hora,
      // sem animação de morte — os modelos do pacote não têm clipe para isso, e
      // deixar o corpo parado em pose de caminhada seria pior que removê-lo.
      if (!criatura.vitais.vivo) {
        this._remove(i);
        continue;
      }
      this._updateCreature(criatura, dt, reference);
    }
  }

  /**
   * Criaturas atacáveis, em espaço de CENA.
   *
   * A conversão acontece aqui, e não em quem atira, porque só a fauna sabe que
   * suas posições são locais ao grupo do planeta. Reaproveita os objetos do
   * array entre chamadas: isto roda todo quadro durante o combate, e alocar
   * doze objetos por quadro é exatamente o tipo de lixo que faz o coletor
   * acordar no pior momento.
   *
   * @param {Array} [saida]
   */
  alvos(saida = this._alvos ?? (this._alvos = [])) {
    saida.length = 0;
    for (const criatura of this.creatures) {
      if (!criatura.vitais.vivo) continue;
      const slot = criatura._slotAlvo ?? (criatura._slotAlvo = { posicao: new THREE.Vector3() });
      slot.posicao.copy(criatura.object.position).add(this.planet.group.position);
      // Meio corpo acima do pé: a origem do modelo fica no chão, e mirar nela
      // exigiria acertar os tornozelos. O "para cima" é a normal do planeta,
      // que é a própria posição local normalizada.
      _alvoCima.copy(criatura.object.position).normalize();
      slot.posicao.addScaledVector(_alvoCima, (criatura.especie.altura ?? 1.4) * 0.5);
      slot.raio = criatura.raioAlvo;
      slot.vitais = criatura.vitais;
      slot.criatura = criatura;
      saida.push(slot);
    }
    return saida;
  }

  _spawn(reference) {
    // ---------------------------------------------------------------------
    // SORTEIO ENTRE AS ESPÉCIES ELEGÍVEIS AGORA, não entre todas.
    //
    // Sortear em toda a lista e rejeitar as noturnas de dia pareceria
    // equivalente e não é: o `while` de repovoamento em `update` para no
    // primeiro `null`, então uma rejeição travaria o pool inteiro naquele
    // quadro. Com a lista já filtrada, todo sorteio devolve alguém.
    // ---------------------------------------------------------------------
    const elegiveis = this._elegiveis;
    const especie = elegiveis[(this._rand() * elegiveis.length) | 0];
    if (!especie) return null;

    // Anel ao redor do jogador: perto o bastante para ser visto, longe o
    // bastante para não aparecer do nada na frente dele.
    const sample = this.planet.sampleAt(reference);
    _up.copy(sample.direction);
    _tangent.set(_up.z, _up.x, _up.y).cross(_up);
    if (_tangent.lengthSq() < 1e-6) _tangent.set(1, 0, 0);
    _tangent.normalize().applyAxisAngle(_up, this._rand() * Math.PI * 2);

    // -----------------------------------------------------------------------
    // BICHO DE TERRA NÃO NASCE NO MAR.
    //
    // Agora que quem anda se cola ao FUNDO (ver `_mover`), nascer sobre água
    // deixou de ser inofensivo: em vez de um bicho pastando na lâmina d'água,
    // seria um bicho no fundo do oceano, invisível e inalcançável. E como o
    // planeta em teste tem 65% de superfície submersa, isso não seria raro —
    // seria a maioria.
    //
    // Algumas tentativas em ângulos diferentes bastam: quem procura terra num
    // mundo com terra a acha rápido, e desistir devolvendo `null` só custa o
    // repovoamento deste quadro (o `while` de `update` para no primeiro nulo e
    // tenta de novo no seguinte).
    // -----------------------------------------------------------------------
    let posicao = null;
    for (let tentativa = 0; tentativa < 6; tentativa++) {
      const distancia = SPAWN_MIN + this._rand() * (SPAWN_MAX - SPAWN_MIN);
      const candidato = reference.clone().addScaledVector(_tangent, distancia);
      const solo = this.planet.sampleAt(candidato);
      if (!this.planet.config.hasWater || solo.elevation > 0.5 || especie.voa) {
        posicao = candidato;
        break;
      }
      _tangent.applyAxisAngle(_up, 1.7);
    }
    if (!posicao) return null;

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
      /**
       * Vitais da criatura.
       *
       * Escudo zero de propósito: escudo é tecnologia, e um bicho não tem. A
       * classe aceita isso sem caso especial — dano com escudo em zero vai
       * inteiro para a blindagem, que é exatamente a regra que se quer aqui.
       *
       * A vida escala com a altura da espécie: acertar um bicho do tamanho de
       * um cavalo não pode custar o mesmo que acertar um do tamanho de um
       * cachorro, e a altura é a única medida de porte que já existe.
       */
      vitais: new Vitais({
        escudoMaximo: 0,
        vidaMaxima: Math.round(22 + (especie.altura ?? 1.4) * 26),
      }),
      /** Raio de acerto, derivado do porte. Ver `Weapons._cruzaEsfera`. */
      raioAlvo: Math.max(0.5, (especie.altura ?? 1.4) * 0.42),

      /** Segundos até a próxima mordida poder acertar. */
      recargaAtaque: 0,
      /** Segundos restantes de perseguição (ver `MEMORIA_CACADA`). */
      cacada: 0,
      /**
       * Segundos de agressividade adquirida.
       *
       * Uma criatura dócil que leva tiro passa a caçar. É a regra que impede o
       * caso mais indefensável do gênero: abater um bicho pastando, de longe,
       * sem nenhuma consequência. Também dá ao jogador a informação de que
       * atirar tem custo, sem precisar de nenhum texto na tela.
       */
      irritada: 0,
      heading: _tangent.clone().applyAxisAngle(_up, this._rand() * Math.PI * 2),
      velocidade: 0,
    };

    // Revide: quem leva tiro passa a caçar, e já sai perseguindo (a `cacada`
    // começa cheia) para que o primeiro tiro tenha resposta imediata em vez de
    // esperar a criatura reparar no jogador no quadro seguinte.
    criatura.vitais.aoLevarDano = () => {
      criatura.irritada = IRRITACAO;
      criatura.cacada = MEMORIA_CACADA;
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
    // `cacar` não é um clipe: é o estado lógico da perseguição, desenhado com a
    // animação de corrida. Sem este mapeamento ele cairia no `idle` e o predador
    // deslizaria pelo chão em pose parada.
    const clipe = estado === 'cacar' ? 'run' : estado;
    const proxima = criatura.acoes[clipe] ?? criatura.acoes.idle;
    if (!proxima) return;

    proxima.reset().setEffectiveWeight(1).play();
    if (anterior && anterior !== proxima) anterior.crossFadeTo(proxima, 0.25, false);

    criatura.estado = estado;
    criatura.velocidade =
      // `cacar` reaproveita o clipe de corrida (é o único que os modelos do
      // pacote têm para deslocamento rápido) mas com velocidade própria: um
      // predador precisa ser mais rápido que a fuga de um herbívoro, senão a
      // caçada nunca termina.
      estado === 'cacar' ? BASE_SPEED * CHASE_SPEED * criatura.especie.velocidade :
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
    if (criatura.recargaAtaque > 0) criatura.recargaAtaque -= dt;

    // ---------------------------------------------------------------------
    // PREDADOR
    //
    // Vem ANTES do bloco de fuga: uma criatura agressiva perto do jogador tem
    // de atacar, não fugir, e o teste de fuga aceitaria as duas. Trocar a ordem
    // faria o predador recuar exatamente quando alcança a presa.
    // ---------------------------------------------------------------------
    if (criatura.especie.agressivo || criatura.irritada > 0) {
      if (criatura.irritada > 0) criatura.irritada -= dt;

      // -------------------------------------------------------------------
      // QUEM LEVOU TIRO ENXERGA MAIS LONGE.
      //
      // Com os raios normais, uma criatura baleada de 80 unidades marcava a
      // irritação e desistia no MESMO quadro — a distância já a punha fora do
      // raio de desistência. O revide existia no papel e nunca acontecia na
      // tela, que é o pior tipo de mecânica: a que parece implementada.
      //
      // Faz sentido além de conveniente: o bicho não precisa detectar ninguém,
      // ele acabou de ser atingido e sabe de onde veio.
      // -------------------------------------------------------------------
      const irritada = criatura.irritada > 0;
      const raioDeteccao = irritada ? RAIO_IRRITADA : RAIO_DETECCAO;
      const raioDesistir = irritada ? RAIO_IRRITADA * 1.6 : RAIO_DESISTIR;

      if (distanciaJogador < raioDeteccao) criatura.cacada = MEMORIA_CACADA;
      else if (criatura.cacada > 0 && distanciaJogador < raioDesistir) criatura.cacada -= dt;
      else criatura.cacada = 0;

      if (criatura.cacada > 0) {
        // Ruma PARA o jogador — o oposto exato da fuga logo abaixo.
        _away.copy(reference).sub(mundo);
        _away.addScaledVector(_up, -_away.dot(_up));
        if (_away.lengthSq() > 1e-6) criatura.heading.copy(_away).normalize();
        this._setState(criatura, 'cacar');
        criatura.timer = 0.6;

        if (distanciaJogador < ALCANCE_ATAQUE && criatura.recargaAtaque <= 0) {
          criatura.recargaAtaque = criatura.especie.cadencia ?? 1.2;
          // O dano não é aplicado aqui: quem sabe o que é o jogador — e se ele
          // está a pé ou dentro da nave — é o loop. A fauna só avisa que
          // acertou. É a mesma separação que mantém `Vitais` neutro.
          this.aoAtacar?.(criatura.especie.dano ?? 8, criatura);
        }
        return this._mover(criatura, dt, _up);
      }
    }

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

    this._mover(criatura, dt, _up);
  }

  /**
   * Passo de movimento, colagem no solo e orientação.
   *
   * Extraído de `_updateCreature` quando a perseguição entrou: a caçada decide o
   * rumo por um caminho próprio e precisa sair da árvore de decisão sem pular o
   * deslocamento. Duplicar estas trinta linhas no ramo do predador seria a
   * receita para elas divergirem na primeira correção.
   */
  _mover(criatura, dt, _up) {
    const objeto = criatura.object;

    // Reprojeta o rumo no plano tangente todo frame, pelo mesmo motivo do
    // jogador a pé: "para frente" muda conforme se anda sobre a esfera.
    criatura.heading.addScaledVector(_up, -criatura.heading.dot(_up));
    if (criatura.heading.lengthSq() < 1e-8) criatura.heading.set(_up.y, -_up.x, 0);
    criatura.heading.normalize();

    if (criatura.velocidade > 0) {
      objeto.position.addScaledVector(criatura.heading, criatura.velocidade * dt);
    }

    // -----------------------------------------------------------------------
    // Cola no chão (ou plana, se for espécie voadora).
    //
    // As duas usam superfícies DIFERENTES, e a distinção é o que tirava os
    // bichos de cima do mar. Quem anda se cola ao chão SÓLIDO — no oceano, o
    // fundo. Quem voa se mede a partir da superfície de APOIO, que sobre a água
    // é o nível do mar: uma ave plana a um metro e meio da lâmina d'água, e não
    // a um metro e meio de um fundo a oitenta unidades de profundidade.
    // -----------------------------------------------------------------------
    const abaixo = this.planet.sampleAt(_delta.copy(objeto.position).add(this.planet.group.position));
    const altura = criatura.especie.voa ? 1.6 + Math.sin(performance.now() * 0.002) * 0.4 : 0;
    const base = criatura.especie.voa ? abaixo.surfaceRadius : abaixo.groundRadius;
    objeto.position.copy(abaixo.direction).multiplyScalar(base + altura);

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
