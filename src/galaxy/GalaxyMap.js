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

/** Teto de estrelas desenhadas — capacidade do buffer instanciado. */
const MAX_ESTRELAS = 24000;

/** Unidades de cena por voxel. */
const ESCALA = 1;

const _cor = new THREE.Color();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _alvoCam = new THREE.Vector3();

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
    /** Onde a câmera orbita, em coordenadas de voxel. */
    this.foco = new THREE.Vector3();
    /** Sistema onde o jogador está agora. */
    this.atual = null;
    /** Sistema sob o cursor do mapa. */
    this.selecionado = null;

    /** Endereços já visitados, como string. @type {Set<string>} */
    this.visitados = new Set();

    // --- Órbita da câmera ---------------------------------------------------
    this.orbita = { distancia: 26, yaw: 0.6, pitch: 0.62 };

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

  _criarEstrelas() {
    // Octaedro e não esfera: a esfera de baixa resolução fica com silhueta
    // hexagonal visível, e a de alta custaria 24 mil vezes mais triângulos. O
    // octaedro tem 8 faces e, do tamanho de um ponto na tela, lê como um brilho.
    const geometria = new THREE.OctahedronGeometry(0.09, 0);
    const material = new THREE.MeshBasicMaterial({
      // SEM `vertexColors`. A cor por estrela vem de `instanceColor`, que é
      // outro caminho no shader: `vertexColors` liga `USE_COLOR` e passa a
      // exigir um atributo `color` na geometria — que um octaedro não tem. O
      // resultado era cor zero em blending aditivo, ou seja, 2 475 estrelas
      // desenhadas e nenhuma visível.
      transparent: true,
      // Aditivo: estrelas próximas somam brilho em vez de se ocultarem, que é o
      // que dá a sensação de densidade no miolo da galáxia.
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });

    const malha = new THREE.InstancedMesh(geometria, material, MAX_ESTRELAS);
    malha.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_ESTRELAS * 3), 3);
    malha.instanceColor.setUsage(THREE.DynamicDrawUsage);
    malha.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    malha.frustumCulled = false;
    malha.count = 0;
    return malha;
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

  _invalidar() {
    this._focoGerado = null;
  }

  /* ===================================================================== */
  /* Geração                                                               */
  /* ===================================================================== */

  _gerar() {
    const cx = Math.round(this.foco.x);
    const cy = Math.round(this.foco.y);
    const cz = Math.round(this.foco.z);

    const nivel = NIVEIS.find((n) => this.orbita.distancia <= n.ate) ?? NIVEIS[NIVEIS.length - 1];

    // Só refaz quando o foco muda de voxel OU o nível de detalhe muda. Arrastar
    // a câmera dentro do mesmo cubo não muda quais estrelas existem.
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
    const malha = this._estrelas;
    let n = 0;

    for (const s of sistemasNoRaio(this.galaxia, cx, cy, cz, nivel.raio, nivel.passo)) {
      if (n >= MAX_ESTRELAS) break;

      const visitado = this.visitados.has(this.chaveDe(s));
      // As estrelas crescem com o passo da amostragem: com 1/64 delas
      // desenhadas, pontos do mesmo tamanho fariam a galáxia parecer esvaziar
      // ao afastar, em vez de simplesmente ficar mais longe.
      const escala = s.classe.tamanho * (visitado ? 1.5 : 1) * (1 + (nivel.passo - 1) * 0.55);

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

      _m.makeScale(escala, escala, escala);
      _m.setPosition((s.x + dx - cx) * ESCALA, (s.y + dy - cy) * ESCALA, (s.z + dz - cz) * ESCALA);
      malha.setMatrixAt(n, _m);

      _cor.setHex(s.classe.cor);
      // Sistema visitado ganha um empurrão de brilho em vez de outra cor: a cor
      // já carrega a classe espectral, e sobrepor as duas informações no mesmo
      // canal tornaria as duas ilegíveis.
      if (visitado) _cor.multiplyScalar(2.1);
      malha.setColorAt(n, _cor);

      s._i = n;
      this._lista.push(s);
      n++;
    }

    malha.count = n;
    malha.instanceMatrix.needsUpdate = true;
    malha.instanceColor.needsUpdate = true;

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

  /** No nível esparso a posição desenhada é aproximada; escolher seria mentir. */
  get podeSelecionar() {
    return (this._nivelGerado?.passo ?? 1) === 1;
  }

  /* ===================================================================== */
  /* Interação                                                             */
  /* ===================================================================== */

  /** Estrela mais próxima do raio da câmera — o "hover". */
  escolherEm(ndcX, ndcY) {
    if (!this.podeSelecionar) return null;
    const raio = new THREE.Raycaster();
    raio.setFromCamera({ x: ndcX, y: ndcY }, this.camera);

    let melhor = null;
    let menor = Infinity;

    for (const s of this._lista) {
      this.posicaoNaCena(s, _v);
      const dist = raio.ray.distanceSqToPoint(_v);
      // Tolerância proporcional à distância da câmera: perto exige precisão,
      // longe seria impossível acertar um ponto de meio pixel.
      const limite = 0.02 + _v.distanceTo(this.camera.position) * 0.012;
      if (dist < limite * limite && dist < menor) {
        menor = dist;
        melhor = s;
      }
    }

    if (melhor) this.selecionado = melhor;
    return melhor;
  }

  orbitar(dx, dy) {
    this.orbita.yaw -= dx * 0.005;
    this.orbita.pitch = THREE.MathUtils.clamp(this.orbita.pitch - dy * 0.005, -1.4, 1.4);
  }

  aproximar(delta) {
    this.orbita.distancia = THREE.MathUtils.clamp(this.orbita.distancia * (1 + delta * 0.0012), 3, 220);
  }

  /** Move o foco para o sistema selecionado (duplo clique / tecla). */
  centralizarNoSelecionado() {
    if (this.selecionado) this.foco.set(this.selecionado.x, this.selecionado.y, this.selecionado.z);
  }

  /** Volta o foco para onde o jogador está. */
  centralizarNoAtual() {
    if (this.atual) this.foco.set(this.atual.x, this.atual.y, this.atual.z);
  }

  trocarGalaxia(delta) {
    this.galaxia = (this.galaxia + delta + GALAXIAS.length) % GALAXIAS.length;
    this._invalidar();
    // Sem sistema atual nesta galáxia: cai no miolo dela, que é onde há
    // estrelas garantidas.
    if (!this.atual || this.atual.galaxia !== this.galaxia) this.foco.set(0, 0, 0);
    this.selecionado = null;
  }

  /* ===================================================================== */
  /* Frame                                                                 */
  /* ===================================================================== */

  atualizar(dt) {
    if (!this.aberto) return;
    this._tempo += dt;
    this._gerar();

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
    return {
      nome: nomeDoSistema(s.seed),
      endereco: chave,
      classe: s.classe.letra,
      planetas: s.planetas,
      visitado: this.visitados.has(chave),
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
