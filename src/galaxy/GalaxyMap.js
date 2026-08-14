/**
 * Mapa galáctico.
 *
 * ===========================================================================
 * AMOSTRAGEM SOB DEMANDA, NÃO UM BANCO DE ESTRELAS
 * ===========================================================================
 * A galáxia tem ~178 mil sistemas e nenhum deles existe até ser perguntado.
 * `shared/galaxy.js` deriva tudo de um hash do endereço do voxel; aqui só se
 * decide QUAIS voxels perguntar e como desenhá-los.
 *
 * O laço é: pegue os voxels num raio ao redor do foco, gere os sistemas deles,
 * escreva posição e cor num `InstancedMesh`. Uma chamada de desenho para
 * milhares de estrelas.
 *
 * ===========================================================================
 * POR QUE NÃO UM COMPUTE SHADER
 * ===========================================================================
 * A referência gera as posições direto na GPU. Isso exige compute shaders, que
 * o WebGL2 não tem — só WebGPU, e migrar para lá significaria reescrever todos
 * os shaders do projeto em TSL. A alternativa fiel seria calcular o hash no
 * vertex shader a partir do `gl_InstanceID`, e ela tem um custo escondido: a
 * seleção com o mouse precisa do mesmo cálculo na CPU, então o hash existiria
 * em duas linguagens e teria de casar bit a bit. Gerar na CPU e enviar um
 * buffer resolve as duas coisas com uma implementação só.
 *
 * A regeneração só acontece quando o foco muda de voxel, então o custo (~15 ms
 * para 14 mil sistemas) não aparece no orçamento do frame.
 *
 * ===========================================================================
 * NÍVEIS DE DETALHE
 * ===========================================================================
 *   distante  ponto luminoso instanciado (o grosso do mapa)
 *   próximo   ponto maior, com halo
 *   selecionado  planetas em órbita, anel de alcance e ficha na tela
 *   fundo     nebulosa por ruído no shader, numa casca ao redor de tudo
 *
 * Rótulo de texto só para o sistema selecionado. Um `<div>` por estrela seria
 * o caminho natural e custaria mil nós de DOM reposicionados por frame — o
 * mapa engasgaria muito antes de o jogador conseguir ler qualquer coisa.
 */

import * as THREE from 'three';
import {
  GALAXIAS, RAIO_GALAXIA, sistemasNoRaio, sistemaEm, nomeDoSistema,
  enderecoUniversal, formatarEndereco, acharPorSeed, voxelDeAncoragem,
} from '../shared/galaxy.js';
import { criarNebulosa } from './Nebula.js';

/**
 * Níveis de varredura, escolhidos pela distância da câmera.
 *
 * É o LOD do mapa no domínio dos VOXELS, e não no dos pixels: afastar não
 * encolhe as estrelas, aumenta a região amostrada e rareia a amostragem. É o
 * que permite ver a espiral inteira — 178 mil sistemas — com o mesmo orçamento
 * de alguns milhares de instâncias.
 *
 * O corte por distância tem histerese embutida na ordem: o primeiro nível cujo
 * limite for maior que a distância vence, e como os limites são bem separados,
 * girar a câmera perto de uma fronteira não fica alternando.
 */
const NIVEIS = [
  { ate: 45, raio: 14, passo: 1 },
  { ate: 110, raio: 34, passo: 2 },
  { ate: 999, raio: RAIO_GALAXIA + 4, passo: 4 },
];

/** Teto de estrelas desenhadas — capacidade do buffer de pontos. */
const MAX_ESTRELAS = 24000;

/** Unidades de cena por voxel. */
const ESCALA = 1;

/**
 * Constante de amortecimento da câmera, por segundo.
 *
 * Nada no mapa se move direto para o valor pedido: giro, zoom e foco perseguem
 * um ALVO com `1 - exp(-k·dt)`. É o que separa um mapa que "salta" de um que
 * desliza — e a diferença não é cosmética. Ao centralizar num sistema a 40
 * anos-luz, o corte instantâneo faz perder completamente a noção de para onde
 * a câmera foi; o deslize mantém a referência espacial durante o trajeto.
 *
 * A forma exponencial (e não um lerp de fator fixo) é o que torna o movimento
 * independente da taxa de quadros: a 30 ou a 144 fps o trajeto dura o mesmo.
 */
const AMORTECIMENTO = 9;

/** Idem, para o foco — um pouco mais lento, porque percorre distâncias maiores. */
const AMORTECIMENTO_FOCO = 6.5;

/**
 * Raio de captura do cursor, em unidades de NDC vertical (metade da altura da
 * tela = 1). 0.045 dá cerca de 32 px numa janela de 1440 de altura.
 *
 * Generoso de propósito: errar uma estrela custa um clique repetido, enquanto
 * uma área apertada faz o mapa parecer não responder — que foi exatamente o
 * defeito relatado. Quando duas estrelas disputam, vence a mais próxima do
 * cursor, então a folga não atrapalha a precisão em campo denso.
 */
const RAIO_ESCOLHA = 0.045;

const _cor = new THREE.Color();
const _v = new THREE.Vector3();
const _alvoCam = new THREE.Vector3();
const _direita = new THREE.Vector3();
const _frente = new THREE.Vector3();

export class GalaxyMap {
  /**
   * @param {object} ctx
   * @param {(sistema:object) => boolean} ctx.podeSaltar alcance do hiperimpulsor
   */
  constructor({ podeSaltar }) {
    this.podeSaltar = podeSaltar;
    this.aberto = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(52, 1, 0.05, 4000);

    this.scene.add(new THREE.AmbientLight(0xffffff, 2.4));

    /** Galáxia em exibição. Pode diferir da atual enquanto se navega. */
    this.galaxia = 0;
    /** Onde a câmera orbita AGORA, em coordenadas de voxel. */
    this.foco = new THREE.Vector3();
    /** Para onde ela está indo. O `foco` persegue isto. */
    this.focoAlvo = new THREE.Vector3();
    /** Sistema onde o jogador está agora. */
    this.atual = null;
    /** Sistema sob o cursor do mapa. */
    this.selecionado = null;

    /** Endereços já visitados, como string. @type {Set<string>} */
    this.visitados = new Set();

    /**
     * Quem descobriu cada sistema.
     *
     * `endereco -> { nome, descobridor, quando }`. Separado de `visitados` de
     * propósito, porque as duas perguntas são diferentes: `visitados` é "EU já
     * estive aqui" (é do save da conta) e isto é "alguém já esteve aqui, e
     * quem" (é da galáxia, vem do servidor e vale para todo mundo). Guardar as
     * duas no mesmo lugar tornaria impossível mostrar um sistema que outra
     * pessoa descobriu e você nunca visitou — que é o caso mais interessante
     * dos dois.
     * @type {Map<string, {nome:string, descobridor:string, quando:string}>}
     */
    this.descobertas = new Map();

    // --- Órbita da câmera ---------------------------------------------------
    // Dois estados: o que está na tela e o que o jogador pediu. Todo comando de
    // navegação escreve só no ALVO; o estado real o persegue em `_suavizar`.
    this.orbita = { distancia: 26, yaw: 0.6, pitch: 0.62 };
    this.alvo = { distancia: 26, yaw: 0.6, pitch: 0.62 };

    /**
     * Eixos do teclado, no referencial da CÂMERA.
     *
     * Voar pelo mapa com WASD é o gesto do No Man's Sky, e ele resolve o que
     * girar-e-aproximar não resolve: alcançar uma região que não está entre a
     * câmera e o foco atual. Sem isso, chegar a um braço vizinho da espiral
     * exige afastar até ver tudo, girar, e aproximar de novo às cegas.
     */
    this.eixos = { frente: 0, lado: 0, cima: 0 };

    this._estrelas = this._criarEstrelas();
    this.scene.add(this._estrelas);

    this.nebulosa = criarNebulosa();
    this.scene.add(this.nebulosa.mesh);

    this._marcadores = this._criarMarcadores();
    this._planetas = this._criarPlanetas();

    /** Sistemas gerados na última varredura. @type {object[]} */
    this._lista = [];
    /** Voxel do último rebuild, para não regenerar sem necessidade. */
    this._focoGerado = null;
    this._galaxiaGerada = -1;

    this._tempo = 0;
  }

  /* ===================================================================== */
  /* Construção da cena                                                    */
  /* ===================================================================== */

  /**
   * O campo de estrelas.
   *
   * ---------------------------------------------------------------------------
   * PONTOS, E NÃO GEOMETRIA SÓLIDA
   * ---------------------------------------------------------------------------
   * Antes cada sistema era um octaedro instanciado. O problema não era custo, e
   * sim o que se via: a esta distância um sólido é um caroço de silhueta dura,
   * com arestas que cintilam conforme a câmera gira. Uma galáxia é o oposto
   * disso — é névoa luminosa, e o que a faz ler como tal é o HALO, o brilho que
   * se espalha para além do núcleo e se soma ao das vizinhas.
   *
   * Um ponto com gradiente radial dá exatamente isso, e ainda troca 8 faces por
   * um vértice: 24 mil estrelas viram 24 mil vértices em vez de 192 mil
   * triângulos, o que é o que permite o campo denso sem orçamento extra.
   *
   * O tamanho na tela é calculado no shader (`gl_PointSize`), com atenuação por
   * distância feita à mão. O piso de 1.6 px é deliberado: sem ele, o miolo da
   * galáxia vista de longe cai abaixo de um pixel e some — a região MAIS densa
   * do mapa vira um buraco preto, que foi o efeito mais estranho da versão
   * anterior ao afastar.
   */
  _criarEstrelas() {
    const geometria = new THREE.BufferGeometry();
    geometria.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(MAX_ESTRELAS * 3), 3).setUsage(THREE.DynamicDrawUsage)
    );
    geometria.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(MAX_ESTRELAS * 3), 3).setUsage(THREE.DynamicDrawUsage)
    );
    geometria.setAttribute(
      'tamanho',
      new THREE.BufferAttribute(new Float32Array(MAX_ESTRELAS), 1).setUsage(THREE.DynamicDrawUsage)
    );
    geometria.setDrawRange(0, 0);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        // Altura do viewport dividida por 2·tan(fov/2): converte tamanho de
        // MUNDO em pixels. Recalculado por frame porque tanto a janela quanto o
        // fov podem mudar sem o mapa saber.
        escalaPonto: { value: 600 },
      },
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute float tamanho;
        uniform float escalaPonto;
        varying vec3 vCor;
        void main() {
          vCor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(tamanho * escalaPonto / max(-mv.z, 0.001), 1.6, 80.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vCor;
        void main() {
          // Distância ao centro do ponto, normalizada em [0,1] na borda.
          float r = length(gl_PointCoord - 0.5) * 2.0;
          if (r > 1.0) discard;
          float d = 1.0 - r;
          // Duas potências somadas: a alta é o núcleo compacto e a baixa é o
          // halo largo. Uma curva só daria ou uma bola chapada ou uma mancha
          // sem centro — é a soma que produz a leitura de "estrela".
          float brilho = pow(d, 5.0) * 1.6 + pow(d, 1.6) * 0.35;
          gl_FragColor = vec4(vCor * brilho, brilho);
        }
      `,
    });

    const pontos = new THREE.Points(geometria, material);
    // O campo é reconstruído em torno do foco e cobre tudo o que a câmera vê;
    // deixar o three calcular uma bounding sphere por rebuild seria trabalho
    // jogado fora.
    pontos.frustumCulled = false;
    return pontos;
  }

  _criarMarcadores() {
    const grupo = new THREE.Group();

    const anel = (raio, cor, largura) =>
      new THREE.Mesh(
        new THREE.RingGeometry(raio - largura, raio, 64),
        new THREE.MeshBasicMaterial({
          color: cor, transparent: true, opacity: 0.85,
          side: THREE.DoubleSide, depthWrite: false, fog: false,
        })
      );

    // Onde o jogador está.
    this.marcadorAtual = anel(0.34, 0xffd77a, 0.05);
    // O que o cursor escolheu.
    this.marcadorSel = anel(0.46, 0x58e8ff, 0.045);

    /**
     * Alcance do hiperimpulsor.
     *
     * Uma ESFERA em wireframe, não um círculo: o mapa é tridimensional, e um
     * círculo plano mentiria sobre o alcance vertical — o jogador tentaria
     * saltar para uma estrela visivelmente "dentro" do anel e receberia uma
     * recusa sem entender por quê.
     */
    this.esferaAlcance = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 2),
      new THREE.MeshBasicMaterial({
        color: 0x58e8ff, wireframe: true, transparent: true,
        opacity: 0.1, depthWrite: false, fog: false,
      })
    );

    // Linha de rota entre o atual e o selecionado.
    this.rota = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0x58e8ff, transparent: true, opacity: 0.9, fog: false })
    );

    grupo.add(this.marcadorAtual, this.marcadorSel, this.esferaAlcance, this.rota);
    this.scene.add(grupo);
    return grupo;
  }

  /**
   * Os planetas do sistema selecionado, como bolas em órbita.
   *
   * Pré-alocados no máximo possível (6) e apenas escondidos quando o sistema
   * tem menos: criar e destruir malhas a cada estrela que o cursor toca faria
   * o coletor de lixo trabalhar durante a navegação, e isso aparece como
   * engasgo justamente enquanto o jogador arrasta o mouse.
   */
  _criarPlanetas() {
    const grupo = new THREE.Group();
    const geometria = new THREE.SphereGeometry(1, 16, 12);
    this._orbes = [];
    this._orbitas = [];

    for (let i = 0; i < 6; i++) {
      const orbe = new THREE.Mesh(
        geometria,
        new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false })
      );
      orbe.visible = false;
      grupo.add(orbe);
      this._orbes.push(orbe);

      const pontos = [];
      for (let a = 0; a <= 64; a++) {
        const t = (a / 64) * Math.PI * 2;
        pontos.push(new THREE.Vector3(Math.cos(t), 0, Math.sin(t)));
      }
      const orbita = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(pontos),
        new THREE.LineBasicMaterial({ color: 0x58e8ff, transparent: true, opacity: 0.22, fog: false })
      );
      orbita.visible = false;
      grupo.add(orbita);
      this._orbitas.push(orbita);
    }

    this.scene.add(grupo);
    return grupo;
  }

  /* ===================================================================== */
  /* Estado                                                                */
  /* ===================================================================== */

  /**
   * Diz ao mapa onde o jogador está.
   *
   * Recebe o SEED do sistema, que é o que o jogo guarda, e procura o voxel que
   * o gera. Ver `acharPorSeed` — o hash é de mão única, então a volta é uma
   * busca local, viável porque o sistema atual está por construção perto do
   * último foco conhecido.
   */
  situar(galaxia, seed, voxelDica) {
    this.galaxia = galaxia;
    const dica = voxelDica ?? { x: 0, y: 0, z: 0 };
    let sistema = acharPorSeed(galaxia, seed, dica.x, dica.y, dica.z, 7);

    if (!sistema) {
      // Semente que não nasceu do mapa (jogo aberto com `?seed=`, ou um save
      // anterior ao mapa existir). `voxelDeAncoragem` garante um ponto DENTRO
      // do disco e com vizinhos — sem isso o mapa abria numa região de
      // densidade zero, literalmente sem nenhuma estrela para escolher.
      const v = voxelDeAncoragem(galaxia, seed);
      sistema = { ...sistemaEm(galaxia, v.x, v.y, v.z, 0), seed };
    }

    this.atual = sistema;
    this.selecionado = sistema;
    this.foco.set(sistema.x, sistema.y, sistema.z);
    this.focoAlvo.copy(this.foco);
    this.marcarVisitado(sistema);
    this._invalidar();
  }

  marcarVisitado(sistema) {
    this.visitados.add(this.chaveDe(sistema));
  }

  chaveDe(sistema) {
    return formatarEndereco(
      enderecoUniversal(sistema.galaxia, sistema.vx, sistema.vy, sistema.vz, sistema.indice)
    );
  }

  /** Lista serializável, para o banco. */
  visitadosParaLista() {
    return [...this.visitados];
  }

  restaurarVisitados(lista) {
    if (Array.isArray(lista)) this.visitados = new Set(lista);
  }

  /**
   * Registra (ou confirma) quem descobriu um sistema.
   *
   * Idempotente e sem sobrescrever: se o endereço já tem dono, a chamada não
   * faz nada. O servidor já garante a mesma coisa, e repetir a garantia aqui é
   * o que mantém o mapa correto no modo offline, onde não há servidor nenhum
   * para arbitrar.
   */
  registrarDescoberta({ endereco, nome, descobridor, quando }) {
    if (!endereco || this.descobertas.has(endereco)) return false;
    this.descobertas.set(endereco, { nome, descobridor, quando });
    return true;
  }

  /** @returns {{nome:string, descobridor:string, quando:string}|null} */
  descobertaDe(sistema) {
    return this.descobertas.get(this.chaveDe(sistema)) ?? null;
  }

  _invalidar() {
    this._focoGerado = null;
  }

  /* ===================================================================== */
  /* Geração                                                               */
  /* ===================================================================== */

  _gerar() {
    const nivel = NIVEIS.find((n) => this.orbita.distancia <= n.ate) ?? NIVEIS[NIVEIS.length - 1];

    // -----------------------------------------------------------------------
    // O CENTRO É QUANTIZADO PELO PASSO DA AMOSTRAGEM.
    //
    // Enquanto o foco só se movia por saltos entre sistemas, arredondar para o
    // voxel mais próximo bastava. Com o mapa navegável — WASD e arrasto movem o
    // foco continuamente — isso passaria a disparar um rebuild de ~15 ms a cada
    // anos-luz percorrido, e no nível mais afastado, onde a varredura é maior,
    // o engasgo cairia justamente durante o movimento.
    //
    // Quantizar pelo passo faz o rebuild acontecer a cada `passo` voxels em vez
    // de a cada um, e é de graça: o conjunto amostrado nesse nível já é o mesmo
    // dentro do bloco.
    // -----------------------------------------------------------------------
    const p = nivel.passo;
    const cx = Math.round(this.foco.x / p) * p;
    const cy = Math.round(this.foco.y / p) * p;
    const cz = Math.round(this.foco.z / p) * p;

    // Só refaz quando o foco muda de bloco OU o nível de detalhe muda. Mover a
    // câmera dentro do mesmo bloco não muda quais estrelas existem.
    if (
      this._focoGerado &&
      this._focoGerado.x === cx && this._focoGerado.y === cy && this._focoGerado.z === cz &&
      this._galaxiaGerada === this.galaxia &&
      this._nivelGerado === nivel
    ) {
      return;
    }
    this._focoGerado = { x: cx, y: cy, z: cz };
    this._galaxiaGerada = this.galaxia;
    this._nivelGerado = nivel;

    this._lista.length = 0;
    const geo = this._estrelas.geometry;
    const posicoes = geo.attributes.position.array;
    const cores = geo.attributes.color.array;
    const tamanhos = geo.attributes.tamanho.array;
    let n = 0;

    for (const s of sistemasNoRaio(this.galaxia, cx, cy, cz, nivel.raio, nivel.passo)) {
      if (n >= MAX_ESTRELAS) break;

      const chave = this.chaveDe(s);
      const visitado = this.visitados.has(chave);
      // Descoberto por ALGUÉM — inclusive por outro jogador, num sistema onde
      // você nunca esteve. É a informação que faz o mapa parecer habitado.
      const descoberto = visitado || this.descobertas.has(chave);
      // As estrelas crescem com o passo da amostragem: com 1/64 delas
      // desenhadas, pontos do mesmo tamanho fariam a galáxia parecer esvaziar
      // ao afastar, em vez de simplesmente ficar mais longe.
      const escala = s.classe.tamanho * (descoberto ? 1.5 : 1) * (1 + (nivel.passo - 1) * 0.55);

      // -------------------------------------------------------------------
      // ESPALHAMENTO NO NÍVEL ESPARSO.
      //
      // Amostrar um voxel a cada `passo` e desenhar a estrela no lugar exato
      // dela deixa a GRADE DE AMOSTRAGEM visível: fileiras e colunas regulares
      // separadas por vazios de quatro anos-luz. A galáxia vira papel
      // quadriculado — foi exatamente o que apareceu na primeira captura.
      //
      // Espalhando cada estrela pelo bloco que ela representa, a densidade
      // volta a parecer contínua. O deslocamento é derivado da semente, então
      // é estável entre frames e entre máquinas.
      //
      // O preço, e ele é honesto: neste nível a posição DESENHADA é aproximada
      // (até meio bloco fora). A posição lógica em `s.x/y/z` continua exata —
      // é ela que decide alcance e destino do salto —, e por isso a seleção
      // fica desligada aqui. Ver `escolherEm`.
      // -------------------------------------------------------------------
      let dx = 0, dy = 0, dz = 0;
      if (nivel.passo > 1) {
        const e = nivel.passo - 1;
        dx = (((s.seed & 0x3ff) / 1024) - 0.5) * e;
        dy = ((((s.seed >>> 10) & 0x3ff) / 1024) - 0.5) * e * 0.5;
        dz = ((((s.seed >>> 20) & 0x3ff) / 1024) - 0.5) * e;
      }
      s._dx = dx; s._dy = dy; s._dz = dz;

      posicoes[n * 3] = (s.x + dx - cx) * ESCALA;
      posicoes[n * 3 + 1] = (s.y + dy - cy) * ESCALA;
      posicoes[n * 3 + 2] = (s.z + dz - cz) * ESCALA;
      // O tamanho vai em unidades de MUNDO (o shader converte para pixels). O
      // fator é o que casa o diâmetro do halo com a antiga esfera de raio 0.09
      // somada ao brilho que ela não tinha.
      tamanhos[n] = escala * 0.34;

      _cor.setHex(s.classe.cor);
      // Sistema conhecido ganha um empurrão de BRILHO em vez de outra cor: a cor
      // já carrega a classe espectral, e sobrepor as duas informações no mesmo
      // canal tornaria as duas ilegíveis. Dois degraus, porque as perguntas são
      // duas: 2.1 para onde VOCÊ esteve, 1.5 para o que outra pessoa registrou.
      if (visitado) _cor.multiplyScalar(2.1);
      else if (descoberto) _cor.multiplyScalar(1.5);
      cores[n * 3] = _cor.r;
      cores[n * 3 + 1] = _cor.g;
      cores[n * 3 + 2] = _cor.b;

      s._i = n;
      this._lista.push(s);
      n++;
    }

    geo.setDrawRange(0, n);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.attributes.tamanho.needsUpdate = true;

    // Tudo é desenhado relativo ao voxel do foco — o mesmo motivo pelo qual o
    // mundo usa origem flutuante. A 96 voxels do centro, coordenadas absolutas
    // em float32 já perderiam a fração que separa duas estrelas vizinhas.
    this._origemLocal = { x: cx, y: cy, z: cz };
  }

  /** Converte um sistema para a posição que ele ocupa na cena do mapa. */
  posicaoNaCena(sistema, alvo) {
    const o = this._origemLocal ?? { x: 0, y: 0, z: 0 };
    // Soma o espalhamento do nível esparso quando existe, para que marcadores e
    // seleção caiam exatamente sobre o ponto DESENHADO — nada é mais confuso do
    // que um anel de seleção ao lado da estrela que ele deveria circundar.
    return alvo.set(
      (sistema.x + (sistema._dx ?? 0) - o.x) * ESCALA,
      (sistema.y + (sistema._dy ?? 0) - o.y) * ESCALA,
      (sistema.z + (sistema._dz ?? 0) - o.z) * ESCALA
    );
  }

  /* ===================================================================== */
  /* Interação                                                             */
  /* ===================================================================== */

  /**
   * Estrela mais próxima do raio da câmera — o "hover".
   *
   * VALE EM QUALQUER NÍVEL DE ZOOM, inclusive no esparso. Antes a seleção era
   * desligada quando a amostragem espalhava as estrelas pelo bloco que
   * representam, com o argumento de que a posição desenhada fica aproximada e
   * apontá-la seria mentir. O argumento estava certo e a conclusão, errada: o
   * efeito prático era que afastar para enxergar a galáxia tirava a única coisa
   * que se quer fazer nela — escolher um destino —, sem nada na tela explicando
   * por quê. O jogador clicava e não acontecia nada.
   *
   * A aproximação é inofensiva onde importa: `s.x/y/z` continua exato, e é ele
   * que decide alcance e destino do salto. O que fica aproximado é apenas em
   * qual das estrelas o cursor cai quando duas estão a meio bloco de distância
   * — e a resposta para isso é aproximar o zoom, que agora é um gesto contínuo.
   */
  escolherEm(ndcX, ndcY) {
    let melhor = null;
    let menor = Infinity;

    for (const s of this._lista) {
      this.posicaoNaCena(s, _v);
      // -------------------------------------------------------------------
      // A ESCOLHA É FEITA NA TELA, não no espaço.
      //
      // A versão anterior media a distância da estrela até o RAIO da câmera,
      // em anos-luz, com uma tolerância estimada a partir da profundidade.
      // Duas coisas davam errado: a tolerância era um chute que só casava com
      // o tamanho desenhado numa faixa estreita de zoom, e a métrica ignora
      // que a mesma distância em anos-luz vale muitos pixels perto e quase
      // nenhum longe. Na prática, boa parte dos cliques caía "ao lado" de uma
      // estrela visivelmente sob o cursor e o mapa não reagia.
      //
      // Projetar e comparar em coordenadas de tela mede exatamente aquilo que
      // o jogador está mirando: pixels. O raio de captura passa a ser um só,
      // válido em qualquer zoom.
      // -------------------------------------------------------------------
      _v.project(this.camera);
      // Fora do frustum (atrás da câmera, sobretudo): projetar continua dando
      // um número, e sem este corte uma estrela às costas pode "ganhar" o
      // clique de outra que está de fato na tela.
      if (_v.z < -1 || _v.z > 1) continue;

      // O `x` é corrigido pelo aspecto: sem isso a área de captura seria uma
      // elipse achatada numa tela larga, mais tolerante na horizontal.
      const dx = (_v.x - ndcX) * this.camera.aspect;
      const dy = _v.y - ndcY;
      const d2 = dx * dx + dy * dy;

      if (d2 < RAIO_ESCOLHA * RAIO_ESCOLHA && d2 < menor) {
        menor = d2;
        melhor = s;
      }
    }

    if (melhor) this.selecionado = melhor;
    return melhor;
  }

  orbitar(dx, dy) {
    this.alvo.yaw -= dx * 0.005;
    this.alvo.pitch = THREE.MathUtils.clamp(this.alvo.pitch - dy * 0.005, -1.4, 1.4);
  }

  /**
   * Roda do mouse.
   *
   * Multiplicativo, e não aditivo: aproximar de 200 para 190 anos-luz é
   * imperceptível, enquanto de 12 para 2 atravessa metade do sistema. Com um
   * passo proporcional, cada clique da roda percorre a mesma FRAÇÃO — o que faz
   * o zoom parecer ter a mesma velocidade em qualquer escala.
   */
  aproximar(delta) {
    this.alvo.distancia = THREE.MathUtils.clamp(this.alvo.distancia * (1 + delta * 0.0016), 2.5, 260);
  }

  /**
   * Arrasto com o botão direito: desliza o mapa no PLANO DA TELA.
   *
   * É o gesto de arrastar um mapa com a mão, e complementa o giro — girar em
   * torno de um foco fixo nunca chega a uma região que não seja vizinha dele.
   * A velocidade acompanha a distância da câmera porque um pixel de tela vale
   * mais anos-luz quanto mais longe se está; sem isso, arrastar de perto voaria
   * e arrastar de longe pareceria travado.
   */
  deslocar(dx, dy) {
    const escala = this.orbita.distancia * 0.0018;
    this.camera.getWorldDirection(_frente);
    _direita.crossVectors(_frente, this.camera.up).normalize();
    // O "para cima" do arrasto é o da CÂMERA, não o do mundo: arrastando com a
    // câmera inclinada, o mapa tem de seguir o dedo, não subir na vertical.
    _v.crossVectors(_direita, _frente).normalize();

    this.focoAlvo.addScaledVector(_direita, -dx * escala);
    this.focoAlvo.addScaledVector(_v, dy * escala);
  }

  /**
   * Voo livre pelo teclado (WASD para o plano, R/Q para a vertical).
   *
   * A velocidade escala com a distância: afastado, atravessa-se a galáxia;
   * aproximado, ajusta-se entre estrelas vizinhas. É o mesmo princípio do zoom
   * multiplicativo — um controle só, útil nas duas pontas da escala.
   */
  mover(dt) {
    const { frente, lado, cima } = this.eixos;
    if (!frente && !lado && !cima) return;

    const passo = this.orbita.distancia * 1.15 * dt;
    this.camera.getWorldDirection(_frente);
    _direita.crossVectors(_frente, this.camera.up).normalize();
    // O "para frente" do WASD é ACHATADO no plano da galáxia. Seguir a direção
    // exata do olhar significaria que olhar de cima para baixo — que é como se
    // examina um disco — transforma o W em mergulho: a tecla de avançar
    // afundaria a câmera para fora do plano onde estão todas as estrelas.
    _frente.y = 0;
    if (_frente.lengthSq() < 1e-6) _frente.set(0, 0, -1);
    _frente.normalize();

    this.focoAlvo.addScaledVector(_direita, lado * passo);
    this.focoAlvo.addScaledVector(_frente, frente * passo);
    this.focoAlvo.y += cima * passo;

    // Fora do disco não há nada para ver, e voar para o vazio é a maneira mais
    // rápida de se perder num mapa 3D sem horizonte.
    const limite = RAIO_GALAXIA + 6;
    const raioXZ = Math.hypot(this.focoAlvo.x, this.focoAlvo.z);
    if (raioXZ > limite) {
      this.focoAlvo.x *= limite / raioXZ;
      this.focoAlvo.z *= limite / raioXZ;
    }
    this.focoAlvo.y = THREE.MathUtils.clamp(this.focoAlvo.y, -limite * 0.35, limite * 0.35);
  }

  /** Move o foco para o sistema selecionado (duplo clique / tecla). */
  centralizarNoSelecionado() {
    if (this.selecionado) {
      this.focoAlvo.set(this.selecionado.x, this.selecionado.y, this.selecionado.z);
    }
  }

  /** Volta o foco para onde o jogador está. */
  centralizarNoAtual() {
    if (this.atual) this.focoAlvo.set(this.atual.x, this.atual.y, this.atual.z);
  }

  /** Corta o deslize e coloca a câmera no destino já — usado ao abrir o mapa. */
  assentar() {
    this.foco.copy(this.focoAlvo);
    this.orbita.distancia = this.alvo.distancia;
    this.orbita.yaw = this.alvo.yaw;
    this.orbita.pitch = this.alvo.pitch;
    this.eixos.frente = this.eixos.lado = this.eixos.cima = 0;
  }

  trocarGalaxia(delta) {
    this.galaxia = (this.galaxia + delta + GALAXIAS.length) % GALAXIAS.length;
    this._invalidar();
    // Sem sistema atual nesta galáxia: cai no miolo dela, que é onde há
    // estrelas garantidas.
    if (!this.atual || this.atual.galaxia !== this.galaxia) this.focoAlvo.set(0, 0, 0);
    this.selecionado = null;
  }

  /* ===================================================================== */
  /* Frame                                                                 */
  /* ===================================================================== */

  atualizar(dt) {
    if (!this.aberto) return;
    this._tempo += dt;

    this.mover(dt);
    this._suavizar(dt);
    this._gerar();

    // O tamanho dos pontos é dado em unidades de MUNDO e convertido para pixels
    // no shader. O fator depende da altura da janela e do fov — os dois mudam
    // sem o mapa ser avisado, então é mais simples recalcular do que rastrear.
    this._estrelas.material.uniforms.escalaPonto.value =
      window.innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));

    // --- Câmera em órbita ---------------------------------------------------
    const o = this.orbita;
    const cosP = Math.cos(o.pitch);
    this.posicaoNaCena(
      { x: this.foco.x, y: this.foco.y, z: this.foco.z, },
      _alvoCam
    );
    this.camera.position.set(
      _alvoCam.x + Math.sin(o.yaw) * cosP * o.distancia,
      _alvoCam.y + Math.sin(o.pitch) * o.distancia,
      _alvoCam.z + Math.cos(o.yaw) * cosP * o.distancia
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(_alvoCam);

    const cfg = GALAXIAS[this.galaxia] ?? GALAXIAS[0];
    this.nebulosa.atualizar(this.camera, this._tempo, cfg.cor, this._origemLocal ?? { x: 0, y: 0, z: 0 });

    // --- Marcadores ---------------------------------------------------------
    const encarar = (malha) => malha.quaternion.copy(this.camera.quaternion);

    if (this.atual && this.atual.galaxia === this.galaxia) {
      this.posicaoNaCena(this.atual, _v);
      this.marcadorAtual.position.copy(_v);
      this.marcadorAtual.visible = true;
      encarar(this.marcadorAtual);

      this.esferaAlcance.position.copy(_v);
      this.esferaAlcance.scale.setScalar(this.alcance ?? 0);
      this.esferaAlcance.visible = (this.alcance ?? 0) > 0;
    } else {
      this.marcadorAtual.visible = false;
      this.esferaAlcance.visible = false;
    }

    if (this.selecionado) {
      this.posicaoNaCena(this.selecionado, _v);
      this.marcadorSel.position.copy(_v);
      this.marcadorSel.visible = true;
      // Pulsa devagar: distingue o cursor do marcador fixo sem outra cor.
      const p = 1 + Math.sin(this._tempo * 3.2) * 0.09;
      this.marcadorSel.scale.setScalar(p);
      encarar(this.marcadorSel);

      const alcancavel = this.podeSaltar(this.selecionado);
      this.marcadorSel.material.color.setHex(alcancavel ? 0x58e8ff : 0xff6b6b);
      this._desenharRota(alcancavel);
      this._desenharPlanetas(this.selecionado, _v);
    } else {
      this.marcadorSel.visible = false;
      this.rota.visible = false;
      this._esconderPlanetas();
    }
  }

  /**
   * Persegue os alvos de foco, giro e zoom.
   *
   * `1 - exp(-k·dt)` e não um fator fixo por frame: com fator fixo o mapa
   * desliza mais rápido a 144 fps do que a 30, e a mesma centralização levaria
   * tempos diferentes em máquinas diferentes.
   */
  _suavizar(dt) {
    const kFoco = 1 - Math.exp(-AMORTECIMENTO_FOCO * dt);
    this.foco.lerp(this.focoAlvo, kFoco);

    const k = 1 - Math.exp(-AMORTECIMENTO * dt);
    this.orbita.yaw += (this.alvo.yaw - this.orbita.yaw) * k;
    this.orbita.pitch += (this.alvo.pitch - this.orbita.pitch) * k;
    // O zoom interpola em escala LOGARÍTMICA. Linearmente, o trecho de 200 para
    // 20 anos-luz consome quase todo o tempo do deslize e o final, onde as
    // estrelas ficam legíveis, passa num piscar — o oposto do que se quer ver.
    const alvoLog = Math.log(this.alvo.distancia);
    const atualLog = Math.log(this.orbita.distancia);
    this.orbita.distancia = Math.exp(atualLog + (alvoLog - atualLog) * k);
  }

  _desenharRota(alcancavel) {
    if (!this.atual || this.atual === this.selecionado || this.atual.galaxia !== this.galaxia) {
      this.rota.visible = false;
      return;
    }
    const pos = this.rota.geometry.attributes.position;
    this.posicaoNaCena(this.atual, _v);
    pos.setXYZ(0, _v.x, _v.y, _v.z);
    this.posicaoNaCena(this.selecionado, _v);
    pos.setXYZ(1, _v.x, _v.y, _v.z);
    pos.needsUpdate = true;
    this.rota.material.color.setHex(alcancavel ? 0x58e8ff : 0xff6b6b);
    this.rota.visible = true;
  }

  /** LOD 0: o sistema sob o cursor mostra seus planetas girando. */
  _desenharPlanetas(sistema, centro) {
    for (let i = 0; i < this._orbes.length; i++) {
      const ativo = i < sistema.planetas;
      this._orbes[i].visible = ativo;
      this._orbitas[i].visible = ativo;
      if (!ativo) continue;

      const raio = 0.7 + i * 0.28;
      const velocidade = 0.55 / (0.6 + i * 0.42);
      // A fase deriva da semente: o mesmo sistema mostra sempre o mesmo arranjo,
      // em vez de reembaralhar toda vez que o cursor passa por cima.
      const fase = ((sistema.seed >>> (i * 3)) & 0xff) / 255 * Math.PI * 2;
      const ang = this._tempo * velocidade + fase;

      this._orbes[i].position.set(
        centro.x + Math.cos(ang) * raio,
        centro.y,
        centro.z + Math.sin(ang) * raio
      );
      this._orbes[i].scale.setScalar(0.07 + (i % 3) * 0.022);
      _cor.setHSL(((sistema.seed >>> (i * 5)) & 0xff) / 255, 0.55, 0.62);
      this._orbes[i].material.color.copy(_cor);

      this._orbitas[i].position.copy(centro);
      this._orbitas[i].scale.setScalar(raio);
    }
  }

  _esconderPlanetas() {
    for (const o of this._orbes) o.visible = false;
    for (const o of this._orbitas) o.visible = false;
  }

  /** Ficha do sistema selecionado, para a interface. */
  fichaSelecionada() {
    const s = this.selecionado;
    if (!s) return null;
    const chave = this.chaveDe(s);
    const descoberta = this.descobertas.get(chave);
    return {
      nome: nomeDoSistema(s),
      endereco: chave,
      classe: s.classe.letra,
      planetas: s.planetas,
      visitado: this.visitados.has(chave),
      // Quem fincou a bandeira, ou `null` se ninguém esteve aqui ainda.
      descobridor: descoberta?.descobridor ?? null,
      quandoDescoberto: descoberta?.quando ?? null,
      atual: this.atual ? s.seed === this.atual.seed : false,
      distancia: this.atual ? Math.hypot(s.x - this.atual.x, s.y - this.atual.y, s.z - this.atual.z) : 0,
      alcancavel: this.podeSaltar(s),
      galaxia: GALAXIAS[this.galaxia]?.nome ?? '—',
    };
  }

  redimensionar(aspecto) {
    this.camera.aspect = aspecto;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this._estrelas.geometry.dispose();
    this._estrelas.material.dispose();
    this.nebulosa.dispose();
    this.scene.clear();
  }
}
