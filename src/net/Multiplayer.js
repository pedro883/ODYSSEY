/**
 * Cliente de multijogador: envia o próprio estado, desenha os outros e aplica
 * o que eles colheram.
 *
 * ---------------------------------------------------------------------------
 * TRÊS DECISÕES QUE DEFINEM O RESTO
 * ---------------------------------------------------------------------------
 *
 * 1. **O seed vem do servidor.** Se o seu universo não for idêntico ao do
 *    outro jogador, sincronizar posição é pior do que não sincronizar: o
 *    avatar dele apareceria enterrado numa montanha que para você não existe.
 *    Ao receber um seed diferente do atual, o cliente recarrega apontando para
 *    o do servidor. É brusco e é o único jeito honesto.
 *
 * 2. **Envio a 12 Hz, desenho a 60.** Mandar um pacote por frame satura o
 *    canal para ganhar nada: ninguém percebe 60 atualizações por segundo de um
 *    boneco a 40 unidades. A suavidade vem da INTERPOLAÇÃO no lado de cá — o
 *    avatar persegue exponencialmente o último estado recebido, do mesmo jeito
 *    que a câmera persegue a nave.
 *
 * 3. **Posições viajam em espaço LOCAL DO PLANETA.** Não em espaço de mundo.
 *    Com origem flutuante (`core/FloatingOrigin.js`) o mundo se desloca sob os
 *    pés de cada jogador em momentos diferentes — a mesma coordenada de cena
 *    significa lugares diferentes em duas máquinas. O centro do planeta é o
 *    único referencial que os dois compartilham.
 */

import * as THREE from 'three';
import { createShip } from '../entities/Ship.js';

/** Frequência de envio do próprio estado. */
const INTERVALO_ENVIO = 1 / 12;

/** Constante de perseguição dos avatares remotos (maior = mais duro). */
const SUAVIZACAO = 9;

const _posicao = new THREE.Vector3();

/** Metros abaixo de 1 km, quilômetros acima — como o resto do HUD. */
function formatarDistancia(valor) {
  if (valor > 1000) return `${(valor / 1000).toFixed(1)} km`;
  return `${valor.toFixed(0)} m`;
}

export class Multiplayer {
  /**
   * @param {object} contexto
   * @param {THREE.Scene} contexto.scene
   * @param {import('../world/StarSystem.js').StarSystem} contexto.starSystem
   * @param {string} contexto.url endereço do servidor
   * @param {number} contexto.seed seed em uso agora
   * @param {(texto: string) => void} [contexto.aviso] callback para o HUD
   */
  constructor({ scene, starSystem, url, seed, aviso, aoConstruir, aoTerraformar, aoExpirarTerreno }) {
    this.scene = scene;
    this.starSystem = starSystem;
    this.url = url;
    this.seed = seed;
    this.aviso = aviso ?? (() => {});
    /** Aplica uma construção vinda da sala (outro jogador ou banco). */
    this.aoConstruir = aoConstruir ?? (() => {});
    /** Aplica escavações vindas da sala. */
    this.aoTerraformar = aoTerraformar ?? (() => {});
    /** Desfaz escavações que estouraram o orçamento do planeta. */
    this.aoExpirarTerreno = aoExpirarTerreno ?? (() => {});

    this.id = null;
    this.conectado = false;
    this.socket = null;

    /** 'conectando' | 'online' | 'offline' — o que o HUD mostra. */
    this.estado = 'conectando';
    this._tentativas = 0;
    this._religar = null;

    /**
     * Nome do piloto, definido na tela inicial.
     *
     * A conexão abre durante o boot (para esconder a latência atrás da geração
     * do terreno), mas o `join` só sai quando a pessoa escolhe o nome — senão a
     * sala anunciaria a entrada de alguém que ainda está no menu, e com um nome
     * inventado que seria trocado logo em seguida.
     */
    this.nome = null;

    /** `true` depois de um login aceito — sem isso o progresso não é salvo. */
    this.autenticado = false;
    this._aguardandoLogin = null;

    /** @type {Map<number, {nome:string, grupo:THREE.Group, nave:object, alvo:object}>} */
    this.remotos = new Map();

    this._acumulador = 0;
    this._ultimoEnvio = { pos: new THREE.Vector3(), modo: '' };
  }

  conectar() {
    clearTimeout(this._religar);
    this.estado = 'conectando';

    try {
      this.socket = new WebSocket(this.url);
    } catch (erro) {
      console.warn('[mp] não foi possível abrir a conexão:', erro.message);
      this._agendarReconexao();
      return;
    }

    this.socket.onopen = () => {
      this.conectado = true;
      this.estado = 'online';
      const reconexao = this._tentativas > 0;
      this._tentativas = 0;
      if (this.nome) this._entrar();
      if (reconexao) this.aviso('SALA RECONECTADA');
    };

    this.socket.onmessage = (evento) => this._receber(JSON.parse(evento.data));

    this.socket.onclose = () => {
      const estavaOnline = this.conectado;
      this.conectado = false;
      this.id = null;
      for (const id of [...this.remotos.keys()]) this._remover(id);
      if (estavaOnline) this.aviso('SALA DESCONECTADA');
      this._agendarReconexao();
    };

    this.socket.onerror = () => {
      // O `onclose` vem logo em seguida e cuida de tudo; sem este handler o
      // navegador imprime um erro não tratado a cada tentativa.
    };
  }

  /**
   * Tenta de novo, sempre.
   *
   * O caso comum não é a rede cair — é o servidor ainda não estar no ar quando
   * o jogo abre. Sem reconexão, subir a sala depois exigiria recarregar a
   * página, e ninguém adivinha isso. O intervalo cresce até 8 s para não
   * martelar o console de quem está jogando sozinho de propósito.
   */
  _agendarReconexao() {
    this.estado = 'offline';
    this._tentativas++;
    const espera = Math.min(1000 * this._tentativas, 8000);
    this._religar = setTimeout(() => this.conectar(), espera);
  }

  /**
   * Define o nome e entra na sala.
   *
   * Chamado quando a tela inicial é confirmada. Se a conexão ainda não abriu,
   * o `onopen` cuida do envio — os dois caminhos existem porque a ordem entre
   * "abrir socket" e "escolher nome" depende da rede e do quanto a pessoa
   * demora lendo os controles.
   */
  identificar(nome) {
    this.nome = nome;
    if (this.conectado) this._entrar();
  }

  /**
   * Autentica (ou cria) a conta e pede o progresso guardado.
   *
   * Separado do `identificar`: quem não põe senha continua jogando, só não
   * salva. Uma PoC que EXIGE conta para entrar perde a pessoa que só queria
   * ver o planeta girar.
   *
   * @returns {Promise<{ok:boolean, erro?:string, progresso?:object, novo?:boolean}>}
   */
  autenticar(login, senha) {
    if (!this.conectado) return Promise.resolve({ ok: false, erro: 'sem conexão com a sala' });

    return new Promise((resolve) => {
      this._aguardandoLogin = resolve;
      this.socket.send(JSON.stringify({ type: 'login', login, senha }));
      // Sem resposta em 8 s tratamos como falha: travar o botão de iniciar para
      // sempre por causa de um pacote perdido seria pior que jogar sem salvar.
      setTimeout(() => {
        if (this._aguardandoLogin === resolve) {
          this._aguardandoLogin = null;
          resolve({ ok: false, erro: 'servidor não respondeu' });
        }
      }, 8000);
    });
  }

  /** Manda o progresso para o banco. Ignorado se não houver conta. */
  salvarProgresso(progresso) {
    if (!this.conectado || !this.autenticado) return;
    this.socket.send(JSON.stringify({ type: 'progresso', progresso }));
  }

  _entrar() {
    this.socket.send(JSON.stringify({ type: 'join', nome: this.nome }));
  }

  /**
   * Alinha o universo ao da sala.
   * @returns {boolean} `true` se vai recarregar (quem chamou deve parar)
   */
  _alinharSeed(seedDaSala) {
    if ((seedDaSala >>> 0) === (this.seed >>> 0)) return false;
    const url = new URL(location.href);
    url.searchParams.set('seed', String(seedDaSala >>> 0));
    location.replace(url.toString());
    return true;
  }

  _receber(mensagem) {
    switch (mensagem.type) {
      case 'login': {
        this.autenticado = mensagem.ok === true;
        const resolve = this._aguardandoLogin;
        this._aguardandoLogin = null;
        resolve?.(mensagem);
        break;
      }

      case 'hello':
        // Chega assim que a conexão abre, antes do `join`: dá tempo de
        // recarregar no seed certo enquanto o terreno ainda está sendo gerado.
        this._alinharSeed(mensagem.seed);
        break;

      case 'welcome': {
        this.id = mensagem.id;
        if (this._alinharSeed(mensagem.seed)) return;

        for (const [chave, indices] of mensagem.colhidos) this._aplicarColheita(chave, indices);
        // As bases inteiras chegam aqui, de uma vez. Cada evento carrega o
        // referencial da própria base (ver `BuildSystem.aplicar`), então a
        // ordem em que eles chegam não importa — inclusive se a peça que criou
        // a base for demolida antes de você entrar.
        // `animar: false` — a base já existia antes de você chegar. Vê-la
        // brotar do chão na entrada faria uma construção de semanas atrás
        // parecer que acabou de acontecer.
        for (const evento of mensagem.construcoes ?? []) this.aoConstruir({ ...evento, animar: false });
        // `emBloco` — ver `aoTerraformar` em `main.js`. Restaurar uma a uma
        // corre contra a geração de terreno que já está em curso desde o boot.
        for (const [planeta, lista] of mensagem.terreno ?? []) this.aoTerraformar?.(planeta, lista, true);
        for (const jogador of mensagem.jogadores) {
          this._garantirRemoto(jogador.id, jogador.nome);
          // `estado` pode ser nulo: quem entrou e ainda não se moveu existe na
          // sala e precisa constar na lista, mesmo sem posição conhecida.
          if (jogador.estado) this._atualizarRemoto(jogador.id, jogador.estado, true);
        }
        this.aviso(`MULTIJOGADOR: ${mensagem.jogadores.length + 1} NA SALA`);
        break;
      }

      case 'entrou':
        this._garantirRemoto(mensagem.id, mensagem.nome);
        this.aviso(`${mensagem.nome.toUpperCase()} ENTROU`);
        break;

      case 'state':
        this._garantirRemoto(mensagem.id, `Piloto ${mensagem.id}`);
        this._atualizarRemoto(mensagem.id, mensagem.estado, false);
        break;

      case 'harvest':
        this._aplicarColheita(`${mensagem.planeta}:${mensagem.chunk}`, [mensagem.indice]);
        break;

      case 'construcao':
        this.aoConstruir(mensagem.evento);
        break;

      case 'terreno':
        this.aoTerraformar?.(mensagem.planeta, [mensagem.edicao]);
        break;

      case 'terreno-expirado':
        // O orçamento do planeta estourou e estas escavações foram abandonadas
        // — o relevo volta ao procedural ali. Ver `MAX_EDICOES_POR_PLANETA` no
        // servidor.
        this.aoExpirarTerreno?.(mensagem.planeta, mensagem.ids);
        break;

      case 'saiu':
        this._remover(mensagem.id);
        break;
    }
  }

  /**
   * Marca props como colhidos por causa de outro jogador.
   *
   * Usa o MESMO caminho da colheita local (`PropScatter.collect`), então o
   * arbusto some da malha instanciada no próximo repack e continua sumido se o
   * chunk for descarregado e voltar — o `harvested` do PropScatter sobrevive.
   */
  _aplicarColheita(chave, indices) {
    const separador = chave.indexOf(':');
    const planetaId = Number(chave.slice(0, separador));
    const chunk = chave.slice(separador + 1);

    const planeta = this.starSystem.byId.get(planetaId);
    if (!planeta) return;

    for (const indice of indices) {
      if (!planeta.props.collect(chunk, indice)) {
        // O chunk pode ainda não ter chegado do worker. Registra no histórico
        // para que, ao chegar, ele já nasça sem o prop colhido.
        let conjunto = planeta.props.harvested.get(chunk);
        if (!conjunto) planeta.props.harvested.set(chunk, (conjunto = new Set()));
        conjunto.add(indice);
      }
    }
  }

  _garantirRemoto(id, nome) {
    if (id === this.id || this.remotos.has(id)) return;

    const grupo = new THREE.Group();
    const nave = createShip();
    grupo.add(nave.group);

    // Avatar de pé: uma cápsula simples. Não vale um modelo animado enquanto o
    // jogo não tem um personagem em primeira pessoa para combinar com ele.
    const corpo = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.4, 1.1, 4, 8),
      new THREE.MeshStandardMaterial({ color: 0x64e8ff, roughness: 0.6, emissive: 0x0b3a4a })
    );
    corpo.position.y = 0.85;
    corpo.visible = false;
    grupo.add(corpo);

    grupo.visible = false; // ver `recebeu` abaixo
    this.scene.add(grupo);
    this.remotos.set(id, {
      nome,
      grupo,
      nave,
      corpo,
      /**
       * `false` até chegar o primeiro pacote de estado.
       *
       * Sem esta guarda o avatar nasce em (0,0,0) do planeta 0 — o CENTRO do
       * primeiro corpo — e o HUD anuncia um companheiro a 34 km enterrado
       * dentro de um planeta, até o primeiro `state` chegar 80 ms depois.
       */
      recebeu: false,
      alvo: {
        planeta: 0,
        pos: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        modo: 'SHIP',
      },
    });
  }

  _atualizarRemoto(id, estado, imediato) {
    const remoto = this.remotos.get(id);
    if (!remoto || !estado) return;

    const primeiro = !remoto.recebeu;
    remoto.recebeu = true;
    remoto.grupo.visible = true;

    remoto.alvo.planeta = estado.p;
    remoto.alvo.pos.fromArray(estado.x);
    remoto.alvo.quat.fromArray(estado.q);
    remoto.alvo.modo = estado.m;

    remoto.nave.group.visible = estado.m === 'SHIP';
    remoto.corpo.visible = estado.m === 'FOOT';

    // Salta direto para a posição no PRIMEIRO pacote, sempre. Interpolar a
    // partir da origem faria o avatar atravessar o sistema estelar voando.
    if (imediato || primeiro) {
      const planeta = this.starSystem.byId.get(estado.p);
      if (planeta) remoto.grupo.position.copy(planeta.group.position).add(remoto.alvo.pos);
      remoto.grupo.quaternion.copy(remoto.alvo.quat);
    }
  }

  _remover(id) {
    const remoto = this.remotos.get(id);
    if (!remoto) return;
    remoto.nave.dispose();
    remoto.corpo.geometry.dispose();
    remoto.corpo.material.dispose();
    remoto.grupo.removeFromParent();
    this.remotos.delete(id);
  }

  /**
   * Quem está na sala, para o HUD — eu primeiro, depois os outros por
   * proximidade.
   *
   * A distância é a que importa para se encontrar: quem está no mesmo planeta
   * ganha metros, quem está em outro corpo ganha o NOME do corpo. Mostrar
   * "38 km" para alguém que está numa lua diferente é uma informação
   * tecnicamente correta e inútil — a pessoa não vai caminhar até lá.
   *
   * @param {THREE.Vector3} minhaPosicao
   * @param {import('../world/Planet.js').Planet} meuPlaneta
   */
  listar(minhaPosicao, meuPlaneta) {
    const meuId = this.starSystem.planets.indexOf(meuPlaneta);

    const outros = [...this.remotos.entries()].map(([id, remoto]) => {
      // Ainda sem posição: ENTRA na lista mesmo assim. Quem acabou de conectar
      // já é um jogador na sala, e omiti-lo faria o contador mentir — que foi
      // exatamente a queixa que originou esta parte.
      if (!remoto.recebeu) {
        return {
          id,
          nome: remoto.nome,
          eu: false,
          longe: false,
          distancia: Infinity,
          posicao: null,
          local: 'localizando…',
        };
      }

      const planeta = this.starSystem.byId.get(remoto.alvo.planeta);
      const mesmoCorpo = remoto.alvo.planeta === meuId;
      const distancia = remoto.grupo.position.distanceTo(minhaPosicao);

      return {
        id,
        nome: remoto.nome,
        eu: false,
        longe: !mesmoCorpo,
        distancia,
        posicao: remoto.grupo.position,
        local: mesmoCorpo
          ? formatarDistancia(distancia)
          : (planeta?.name ?? 'em trânsito'),
      };
    });

    outros.sort((a, b) => a.distancia - b.distancia);

    return [
      { id: this.id, nome: this.nome ?? 'você', eu: true, longe: false, local: 'você' },
      ...outros,
    ];
  }

  /**
   * Avisa a sala de uma construção ou demolição.
   *
   * O evento vai CRU, do mesmo formato que o `BuildSystem` já produziu e
   * consome. Traduzir para um formato de rede próprio criaria dois esquemas
   * para a mesma coisa, e o segundo é sempre o que fica desatualizado.
   */
  construiu(evento) {
    if (!this.conectado) return;
    this.socket.send(JSON.stringify({ type: 'construcao', evento }));
  }

  /**
   * Avisa a sala de uma escavação.
   *
   * Vai a 8 Hz enquanto o botão está pressionado, e não por frame: a mesma
   * edição é reenviada com a profundidade crescendo (ver `Terraform`), então
   * pacotes perdidos ou pulados se corrigem sozinhos no envio seguinte. É a
   * vantagem de transmitir ESTADO em vez de incremento.
   */
  terraformou(planeta, edicao) {
    if (!this.conectado) return;
    this.socket.send(JSON.stringify({ type: 'terreno', planeta, edicao }));
  }

  /** Avisa a sala de que um prop foi colhido aqui. */
  colheu(planetaId, chunk, indice) {
    if (!this.conectado) return;
    this.socket.send(JSON.stringify({ type: 'harvest', planeta: planetaId, chunk, indice }));
  }

  /**
   * @param {number} dt
   * @param {object} local estado do jogador desta máquina
   */
  update(dt, local) {
    if (!this.conectado) return;

    // --- Envio -------------------------------------------------------------
    this._acumulador += dt;
    if (this._acumulador >= INTERVALO_ENVIO) {
      this._acumulador = 0;

      const planeta = local.planeta;
      const id = this.starSystem.planets.indexOf(planeta);
      _posicao.copy(local.posicao).sub(planeta.group.position); // espaço do planeta

      this.socket.send(
        JSON.stringify({
          type: 'state',
          estado: {
            p: id,
            x: _posicao.toArray().map((v) => Math.round(v * 100) / 100),
            q: local.quaternion.toArray().map((v) => Math.round(v * 1000) / 1000),
            m: local.modo,
          },
        })
      );
    }

    // --- Interpolação dos outros -------------------------------------------
    const k = 1 - Math.exp(-SUAVIZACAO * dt);
    for (const remoto of this.remotos.values()) {
      if (!remoto.recebeu) continue;
      const planeta = this.starSystem.byId.get(remoto.alvo.planeta);
      if (!planeta) continue;
      _posicao.copy(planeta.group.position).add(remoto.alvo.pos);
      remoto.grupo.position.lerp(_posicao, k);
      remoto.grupo.quaternion.slerp(remoto.alvo.quat, k);
    }
  }

  dispose() {
    for (const id of [...this.remotos.keys()]) this._remover(id);
    this.socket?.close();
  }
}
