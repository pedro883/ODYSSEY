/**
 * Construção de bases.
 *
 * ===========================================================================
 * O PROBLEMA: UMA GRADE MODULAR NUM PLANETA REDONDO
 * ===========================================================================
 * Peças modulares pressupõem uma grade cartesiana — quadrados que se repetem
 * infinitamente em X e Z. Um planeta não tem isso. Qualquer tentativa de cobrir
 * uma esfera com quadrados iguais falha: ou eles se sobrepõem nos polos, ou
 * abrem fendas no equador. É o mesmo motivo pelo qual todo mapa-múndi mente.
 *
 * A saída aqui é não tentar. Uma base não é um recorte de uma grade global; ela
 * é uma PLACA TANGENTE à superfície, com grade própria:
 *
 *   - a primeira peça define a origem (um ponto do terreno) e um referencial
 *     ortonormal — Y radial, Z na direção em que o jogador olhava, arredondada
 *     para o múltiplo de 90° mais próximo;
 *   - todas as peças seguintes moram na rede de inteiros DESSE referencial.
 *
 * Com isso, o encaixe é exato (coordenadas inteiras não acumulam erro), a
 * sincronia pela rede vira três inteiros por peça, e a curvatura só apareceria
 * numa base de centenas de metros — num planeta de milhares de unidades de
 * raio, muito além do que se constrói à mão.
 *
 * A escala do grupo faz o trabalho pesado: `grupo.scale = ESCALA_CELULA`. Como
 * o kit do Kenney já é 1×1, a rede de inteiros do grupo É a grade da base, e
 * nenhuma conversão aparece no resto do código.
 *
 * ===========================================================================
 * INSTANCEDMESH E NÃO CLONES
 * ===========================================================================
 * Clonar um `Object3D` por peça é o caminho óbvio e custa um draw call por
 * parede. Uma base modesta tem 150 peças — 150 draw calls, mais do que o jogo
 * inteiro gasta hoje com terreno. Aqui cada base mantém um `InstancedMesh` por
 * TIPO de peça, reconstruído quando a base muda. O custo passa a ser o número
 * de tipos distintos (no máximo 15), e reconstruir 150 matrizes no clique é
 * imperceptível.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { assets } from '../assets/AssetLibrary.js';
import { PECAS, PECA_POR_ID, CATEGORIAS, ESCALA_CELULA, caminhosDePecas } from '../assets/buildings.js';
import { EDICAO } from '../shared/edits.js';

/**
 * Alcance da mira de construção, em unidades de mundo.
 *
 * Seis células. Curto o bastante para que a peça caia onde a pessoa está
 * olhando de verdade, e não num quadrado a trinta metros que ela mal distingue
 * — pelo mesmo motivo que o feixe de mineração foi encurtado (ver `Scanner`).
 */
const ALCANCE = 18;

/** Distância máxima até uma base para que a peça entre NELA e não crie outra. */
const RAIO_DA_BASE = 60;

/**
 * Teto de peças por base.
 *
 * Três mil é o mesmo número que o jogo do gênero usa para o que aceita subir
 * ao servidor, e o motivo é o mesmo: acima disso, o pacote que todo visitante
 * precisa baixar antes de ver a base deixa de caber num carregamento discreto.
 * Aqui há um segundo motivo, mais imediato — cada peça é uma matriz reescrita a
 * cada mudança da base, e a reconstrução deixaria de ser imperceptível.
 */
const MAX_PECAS_POR_BASE = 3000;

/** Meia-largura do jogador para colisão, em unidades de mundo. */
const RAIO_JOGADOR = 0.45;
/** Altura do corpo do jogador (pés ao topo da cabeça). */
const ALTURA_JOGADOR = 1.8;

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _local = new THREE.Vector3();
const _dirLocal = new THREE.Vector3();
const _correcao = new THREE.Vector3();
const _matriz = new THREE.Matrix4();
const _eixoX = new THREE.Vector3();
const _eixoY = new THREE.Vector3();
const _eixoZ = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const EIXO_Y = new THREE.Vector3(0, 1, 0);

/**
 * Deslocamento da peça de borda dentro da célula, por face canônica.
 *
 * Só existem duas faces canônicas (ver `_canonizar`): a aresta −Z e a aresta +X.
 * As outras duas são as mesmas arestas vistas da célula vizinha, e tratá-las
 * como slots distintos permitiria duas paredes ocupando exatamente o mesmo
 * lugar — o clássico z-fighting de editor de base.
 */
const OFFSET_BORDA = {
  0: [0, 0, -0.5],
  3: [0.5, 0, 0],
};

/**
 * Discriminadores de slot dentro de uma célula.
 *
 * Os negativos são camadas empilhadas (piso e o que está sobre ele); 0 e 3 são
 * as arestas canônicas. Um valor por slot é o que permite guardar tudo num
 * `Map` de string e, no banco, numa chave primária só.
 */
const SLOT_PISO = -1;
const SLOT_MOBILIA = -2;
/** Todos os slots de uma célula — a ordem em que as buscas os percorrem. */
const SLOTS = [SLOT_PISO, SLOT_MOBILIA, 0, 3];

/** Slot que um tipo de encaixe ocupa (bordas decidem a face na hora de mirar). */
function slotDe(encaixe) {
  return encaixe === 'mobilia' ? SLOT_MOBILIA : SLOT_PISO;
}

/** Duração da animação de surgimento de uma peça, em segundos. */
const DURACAO_SURGIMENTO = 0.3;

/**
 * Folga entre a borda da base e a borda do terreno aplainado, em células.
 *
 * Sem folga, o platô termina exatamente na parede e a base fica com o pé numa
 * escarpa vertical. Com duas células sobra um terraço para andar em volta.
 */
const FOLGA_PLATO = 2;

/**
 * Curva de surgimento com leve ultrapassagem.
 *
 * A peça passa de 1,0 e volta. Um crescimento monótono lê como "carregou"; a
 * ultrapassagem lê como "encaixou", que é a informação que o jogador quer — e é
 * a mesma razão pela qual toda interface boa usa esta curva em vez de linear.
 */
function surgimento(t) {
  const s = 1.9;
  const u = t - 1;
  return 1 + u * u * ((s + 1) * u + s);
}

/** Gera um identificador curto de base. */
function novoId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Achata a cena do glTF SEM normalizar.
 *
 * É a diferença essencial em relação a `AssetLibrary._flatten()`, que força
 * altura 1 para que o espalhamento de props possa pedir "um arbusto de 90 cm".
 * Aqui a escala do artista É a informação: ela é o que faz a parede ter
 * exatamente a largura do piso. Normalizar transformaria um kit modular numa
 * pilha de peças do mesmo tamanho.
 */
function achatarCru(cena) {
  const partes = [];
  cena.updateMatrixWorld(true);
  cena.traverse((no) => {
    if (!no.isMesh || !no.geometry) return;
    const g = no.geometry.clone();
    g.applyMatrix4(no.matrixWorld);
    for (const nome of Object.keys(g.attributes)) {
      if (!['position', 'normal', 'uv'].includes(nome)) g.deleteAttribute(nome);
    }
    g.morphAttributes = {};
    partes.push(g);
  });

  if (partes.length === 0) return null;
  const unida = partes.length === 1 ? partes[0] : mergeGeometries(partes, false);
  if (partes.length > 1) for (const p of partes) p.dispose();
  if (!unida) return null;

  unida.computeBoundingBox();
  return unida;
}

export class BuildSystem {
  /**
   * @param {object} ctx
   * @param {import('../world/StarSystem.js').StarSystem} ctx.starSystem
   * @param {import('./Inventory.js').Inventory} ctx.inventory
   */
  constructor({ starSystem, inventory }) {
    this.starSystem = starSystem;
    this.inventory = inventory;

    /** @type {Map<string, object>} bases por id */
    this.bases = new Map();

    /** Modo construção ligado? Só existe a pé. */
    this.ativo = false;
    /** Índice da peça selecionada em `PECAS`. */
    this.selecao = 0;
    /** Rotação em quartos de volta, 0..3. */
    this.giro = 0;

    /** Resultado da mira deste frame — o HUD e o `colocar()` leem daqui. */
    this.mira = null;

    /** @type {Map<string, THREE.BufferGeometry>} */
    this.geometrias = new Map();
    this.material = null;
    this.materialFantasma = null;
    this.pronto = false;

    this._grupoFantasma = new THREE.Group();
    this._grupoFantasma.scale.setScalar(ESCALA_CELULA);
    this._malhaFantasma = null;

    /**
     * Contorno da célula alvo.
     *
     * O fantasma translúcido sozinho é ambíguo em terreno acidentado — a peça
     * some contra o fundo e o jogador não sabe se vai cair no quadrado que está
     * olhando ou no vizinho. A moldura responde isso sem depender da silhueta
     * do modelo, que muda a cada peça.
     */
    this._moldura = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 0.02, 1)),
      new THREE.LineBasicMaterial({ color: 0x58e8ff, transparent: true, opacity: 0.85, fog: false })
    );
    this._moldura.frustumCulled = false;
    this._grupoFantasma.add(this._moldura);

    /** Bases cujo platô precisa ser recalculado no próximo `atualizar`. */
    this._aplanarPendente = new Set();
    /** Há alguma peça em animação de surgimento? */
    this._animando = false;
  }

  get peca() {
    return PECAS[this.selecao];
  }

  /** Repassados à interface para que ela não importe o catálogo direto. */
  get pecas() {
    return PECAS;
  }

  get categorias() {
    return CATEGORIAS;
  }

  /** Miniatura da peça, como data URL. Ver `_gerarMiniaturas`. */
  miniatura(id) {
    return this._miniaturas.get(id) ?? '';
  }

  /* ===================================================================== */
  /* Preparação                                                            */
  /* ===================================================================== */

  /** Carrega e achata os modelos do kit. Chamado uma vez, no boot. */
  async preparar() {
    await assets.preload(caminhosDePecas());

    // Todas as peças do Space Station Kit compartilham UM material e UMA
    // textura (o colormap do pack). Um material só para o kit inteiro é o que
    // permite depois trocar de InstancedMesh sem trocar de estado de shader.
    const textura = assets.textureFor('base/floor.glb');
    this.material = new THREE.MeshStandardMaterial({
      map: textura,
      roughness: 0.65,
      metalness: 0.15,
    });

    this.materialFantasma = new THREE.MeshStandardMaterial({
      color: 0x58e8ff,
      emissive: 0x1d6b7d,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });

    for (const peca of PECAS) {
      const cena = assets.getSceneSync(peca.modelo);
      const geometria = cena ? achatarCru(cena) : null;
      if (!geometria) {
        console.warn(`[build] modelo ausente: ${peca.modelo} — a peça "${peca.id}" fica indisponível`);
        continue;
      }
      this.geometrias.set(peca.id, geometria);

      // Caixa de colisão, em unidades de célula. Vem da própria geometria, e
      // não de números escritos à mão: trocar de kit não exige remedir nada.
      const caixa = geometria.boundingBox;
      peca.caixa = {
        min: [caixa.min.x, caixa.min.y, caixa.min.z],
        max: [caixa.max.x, caixa.max.y, caixa.max.z],
      };
    }

    // Espessura da laje, medida do próprio modelo. A mobília sobe exatamente
    // isto quando há piso sob ela; escrever "0,3" à mão aqui só funcionaria até
    // alguém trocar o kit.
    this.espessuraPiso = this.geometrias.get('piso')?.boundingBox.max.y ?? 0;

    this._gerarMiniaturas();

    this.pronto = this.geometrias.size > 0;
    return this.pronto;
  }

  /**
   * Renderiza uma miniatura de cada peça, uma vez, no boot.
   *
   * ---------------------------------------------------------------------
   * POR QUE NÃO DESENHAR ÍCONES À MÃO
   * ---------------------------------------------------------------------
   * Vinte e sete ícones desenhados um a um envelhecem no primeiro dia em que
   * alguém acrescenta uma peça ao catálogo — e ninguém lembra de desenhar o
   * ícone junto. Renderizando a própria geometria, o catálogo NUNCA fica
   * dessincronizado da arte: a miniatura é a peça.
   *
   * O renderer é temporário e descartado no fim. Um segundo contexto WebGL
   * vivendo ao lado do principal é um desperdício permanente de VRAM por um
   * trabalho que dura 40 ms.
   */
  _gerarMiniaturas() {
    const TAM = 96;
    /** @type {Map<string, string>} */
    this._miniaturas = new Map();

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      // Sem um segundo contexto disponível (drivers antigos, muitos canvas na
      // página) o catálogo simplesmente fica sem miniatura. Não é motivo para
      // impedir alguém de construir.
      console.warn('[build] sem contexto para miniaturas — o catálogo fica só com texto');
      return;
    }

    renderer.setSize(TAM, TAM);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const cena = new THREE.Scene();
    const luz = new THREE.DirectionalLight(0xffffff, 2.6);
    luz.position.set(3, 5, 4);
    cena.add(luz, new THREE.AmbientLight(0x9fc4d8, 1.4));

    // Ortográfica e não perspectiva: peças de proporções muito diferentes (um
    // piso chato e um pilar alto) precisam ocupar o mesmo quadro sem que a
    // distorção de perspectiva mude o "tamanho aparente" entre elas.
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 40);
    const malha = new THREE.Mesh(undefined, this.material);
    cena.add(malha);

    const centro = new THREE.Vector3();
    const tamanho = new THREE.Vector3();

    for (const peca of PECAS) {
      const geometria = this.geometrias.get(peca.id);
      if (!geometria) continue;

      malha.geometry = geometria;
      geometria.boundingBox.getCenter(centro);
      geometria.boundingBox.getSize(tamanho);

      // Enquadra pela maior dimensão, com folga de 15%.
      const raio = Math.max(tamanho.x, tamanho.y, tamanho.z) * 0.62 || 0.5;
      camera.left = -raio;
      camera.right = raio;
      camera.top = raio;
      camera.bottom = -raio;
      camera.updateProjectionMatrix();

      // Três quartos, ligeiramente de cima: o ângulo que revela largura, altura
      // e profundidade ao mesmo tempo. De frente, um piso vira uma linha.
      camera.position.set(centro.x + 4, centro.y + 3.2, centro.z + 4.6);
      camera.lookAt(centro);

      renderer.render(cena, camera);
      this._miniaturas.set(peca.id, renderer.domElement.toDataURL('image/png'));
    }

    renderer.dispose();
    renderer.forceContextLoss();
  }

  /* ===================================================================== */
  /* Modo                                                                  */
  /* ===================================================================== */

  alternar(ligado) {
    this.ativo = ligado ?? !this.ativo;
    if (!this.ativo) this._esconderFantasma();
    return this.ativo;
  }

  selecionar(delta) {
    const total = PECAS.length;
    this.selecao = (((this.selecao + delta) % total) + total) % total;
    this._malhaFantasma = null; // a geometria mudou; o fantasma é refeito
  }

  selecionarIndice(indice) {
    if (indice < 0 || indice >= PECAS.length) return;
    this.selecao = indice;
    this._malhaFantasma = null;
  }

  girar(delta = 1) {
    this.giro = (this.giro + delta + 4) % 4;
  }

  /* ===================================================================== */
  /* Mira                                                                  */
  /* ===================================================================== */

  /**
   * Decide onde a peça cairia, e mostra o fantasma.
   *
   * @param {THREE.Vector3} olho posição de mundo
   * @param {THREE.Vector3} direcao normalizada
   * @param {import('../world/Planet.js').Planet} planeta
   */
  mirar(olho, direcao, planeta) {
    this.mira = null;
    if (!this.ativo || !this.pronto) {
      this._esconderFantasma();
      return null;
    }

    const peca = this.peca;
    if (!this.geometrias.has(peca.id)) {
      this._esconderFantasma();
      return null;
    }

    const planetaId = this.starSystem.planets.indexOf(planeta);
    const base = this._baseMaisProxima(planetaId, olho);
    // A inversa precisa ser a DESTE frame: a origem flutuante pode ter
    // recentralizado o mundo desde a última vez que a colisão a atualizou.
    if (base) this._atualizarMatrizes(base);
    const alvo = base ? this._mirarNaBase(base, olho, direcao) : this._mirarNoTerreno(olho, direcao, planeta);
    if (!alvo) {
      this._esconderFantasma();
      return null;
    }

    // --- Célula ------------------------------------------------------------
    const cel = [Math.round(alvo.local.x), Math.round(alvo.local.y), Math.round(alvo.local.z)];

    let face = slotDe(peca.encaixe);
    let giro = this.giro;
    if (peca.encaixe === 'borda') {
      // A aresta é a MAIS PRÓXIMA do ponto mirado, não a que o giro manual
      // escolheria. Escolher parede por tecla é o tipo de fricção que faz
      // ninguém construir nada: apontar para a beirada do piso já diz tudo.
      ({ face, giro } = this._arestaMaisProxima(alvo.local, cel));
      const canonico = this._canonizar(cel, face);
      cel[0] = canonico.cel[0];
      cel[1] = canonico.cel[1];
      cel[2] = canonico.cel[2];
      face = canonico.face;
    }

    // --- Encaixe --------------------------------------------------------
    // O slot mirado pode estar ocupado por um vizinho que a pessoa nem estava
    // olhando — é o caso comum ao contornar um cômodo colocando parede atrás de
    // parede. Em vez de recusar, escorregamos para o encaixe livre mais próximo.
    // Sem isto, construir um perímetro exige mirar cada aresta com precisão de
    // pixel, e o jogador culpa o jogo por "não deixar".
    let face2 = face;
    let cel2 = cel;
    if (base?.pecas.has(`${cel[0]},${cel[1]},${cel[2]},${face}`)) {
      const livre = this._encaixeLivre(base, alvo.local, cel, face, peca);
      if (livre) {
        cel2 = livre.cel;
        face2 = livre.face;
        if (peca.encaixe === 'borda') giro = livre.giro;
      }
    }
    cel.length = 0;
    cel.push(...cel2);
    face = face2;

    const chave = `${cel[0]},${cel[1]},${cel[2]},${face}`;
    const ocupado = base?.pecas.has(chave) ?? false;
    const pago = this._podePagar(peca.custo);
    const cheia = (base?.pecas.size ?? 0) >= MAX_PECAS_POR_BASE;

    this.mira = {
      base,
      planetaId,
      // Frame de uma base AINDA NÃO criada: viaja junto na mensagem de rede,
      // para que o outro cliente consiga materializá-la sem ter visto a criação.
      frame: base ? null : alvo.frame,
      cel,
      face,
      giro,
      chave,
      valido: !ocupado && pago && !cheia,
      motivo: cheia ? 'base no limite de peças' : ocupado ? 'ocupado' : pago ? null : 'recursos insuficientes',
    };

    this._mostrarFantasma(planeta, base, alvo.frame, cel, face, giro, this.mira.valido);
    return this.mira;
  }

  /**
   * Ponto onde o raio encosta no terreno.
   *
   * Marcha em passos curtos em vez de fazer raycast contra a malha: o terreno
   * é gerado por chunks que entram e saem de cena, e o amostrador analítico
   * (`planeta.sampleAt`) responde igual mesmo onde a geometria ainda não chegou.
   */
  _mirarNoTerreno(olho, direcao, planeta) {
    for (let d = 1.5; d <= ALCANCE; d += 0.5) {
      _p.copy(olho).addScaledVector(direcao, d);
      if (planeta.sampleAt(_p).altitude <= 0) {
        const frame = this._frameDaBase(planeta, _p, direcao);
        // A origem da base FUTURA é este ponto, logo a célula é a (0,0,0).
        return { local: new THREE.Vector3(0, 0, 0), frame };
      }
    }
    return null;
  }

  /**
   * Ponto mirado dentro de uma base existente, em coordenadas de célula.
   *
   * Testa o terreno E os planos horizontais de cada nível já construído, e fica
   * com o mais próximo. Sem os planos, quem sobe para o segundo andar continua
   * mirando o chão lá embaixo — o raio atravessa o piso em que a pessoa está de
   * pé e a peça nova nasceria um andar abaixo, dentro do que já existe.
   */
  _mirarNaBase(base, olho, direcao) {
    _local.copy(olho).applyMatrix4(base.inversa);
    _dirLocal.copy(direcao).transformDirection(base.inversa).normalize();

    const alcanceLocal = ALCANCE / ESCALA_CELULA;
    let melhor = Infinity;
    let ponto = null;

    for (const nivel of base.niveis) {
      // Plano y = nivel. Um raio paralelo ao plano não o encontra.
      if (Math.abs(_dirLocal.y) < 1e-4) continue;
      const t = (nivel - _local.y) / _dirLocal.y;
      if (t <= 0.3 || t > alcanceLocal || t >= melhor) continue;

      _q.copy(_local).addScaledVector(_dirLocal, t);
      // Longe demais do que existe: é céu aberto, não superfície construída.
      if (!this._temVizinho(base, Math.round(_q.x), nivel, Math.round(_q.z))) continue;

      melhor = t;
      ponto = _q.clone();
    }

    if (ponto) return { local: ponto, frame: null };

    // Nenhum plano serve: cai no terreno e converte para o espaço da base.
    const planeta = this.starSystem.planets[base.planetaId];
    for (let d = 1.5; d <= ALCANCE; d += 0.5) {
      _p.copy(olho).addScaledVector(direcao, d);
      if (planeta.sampleAt(_p).altitude <= 0) {
        return { local: _p.clone().applyMatrix4(base.inversa), frame: null };
      }
    }
    return null;
  }

  /** Existe alguma peça na célula ou coladas nela? (evita construir no vazio) */
  _temVizinho(base, x, y, z) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const face of SLOTS) {
          if (base.pecas.has(`${x + dx},${y},${z + dz},${face}`)) return true;
          if (base.pecas.has(`${x + dx},${y - 1},${z + dz},${face}`)) return true;
        }
      }
    }
    return false;
  }

  /**
   * Encaixe vago mais próximo, quando o mirado está ocupado.
   *
   * Procura só na vizinhança imediata e devolve o candidato mais perto do ponto
   * de fato mirado — assim o deslize é sempre na direção em que a pessoa já
   * estava olhando, e nunca "pula" para o outro lado do cômodo.
   */
  _encaixeLivre(base, local, cel, face, peca) {
    const candidatos = [];

    if (peca.encaixe === 'borda') {
      // As outras três arestas desta célula, e as quatro da célula ao lado.
      for (let f = 0; f < 4; f++) {
        for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const c = this._canonizar([cel[0] + dx, cel[1], cel[2] + dz], f);
          candidatos.push({ cel: c.cel, face: c.face, giro: f });
        }
      }
    } else {
      const slot = slotDe(peca.encaixe);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        candidatos.push({ cel: [cel[0] + dx, cel[1], cel[2] + dz], face: slot, giro: this.giro });
      }
    }

    let melhor = null;
    let menor = Infinity;
    for (const c of candidatos) {
      if (base.pecas.has(`${c.cel[0]},${c.cel[1]},${c.cel[2]},${c.face}`)) continue;
      const offset = c.face >= 0 ? OFFSET_BORDA[c.face] : null;
      const dx = c.cel[0] + (offset ? offset[0] : 0) - local.x;
      const dz = c.cel[2] + (offset ? offset[2] : 0) - local.z;
      const d = dx * dx + dz * dz;
      if (d < menor) {
        menor = d;
        melhor = c;
      }
    }
    return melhor;
  }

  /** Qual das quatro arestas da célula está mais perto do ponto mirado. */
  _arestaMaisProxima(local, cel) {
    const dx = local.x - cel[0];
    const dz = local.z - cel[2];
    // Compara |dx| com |dz|: a aresta mais próxima é a do eixo em que o ponto
    // mais se afastou do centro.
    if (Math.abs(dz) >= Math.abs(dx)) {
      return dz < 0 ? { face: 0, giro: 0 } : { face: 2, giro: 2 };
    }
    return dx > 0 ? { face: 3, giro: 3 } : { face: 1, giro: 1 };
  }

  /**
   * Reduz as quatro faces às duas canônicas.
   *
   * A aresta +Z da célula C é fisicamente a MESMA que a aresta −Z da célula
   * seguinte. Guardar as duas como slots diferentes deixaria duas paredes no
   * mesmo plano — invisível na hora de construir e impossível de demolir
   * depois, porque só uma delas responde ao clique.
   */
  _canonizar(cel, face) {
    if (face === 2) return { cel: [cel[0], cel[1], cel[2] + 1], face: 0 };
    if (face === 1) return { cel: [cel[0] - 1, cel[1], cel[2]], face: 3 };
    return { cel: [...cel], face };
  }

  /* ===================================================================== */
  /* Colocar e demolir                                                     */
  /* ===================================================================== */

  /**
   * Constrói o que estiver sob a mira.
   * @returns {{ok:boolean, erro?:string, evento?:object}}
   */
  colocar() {
    const mira = this.mira;
    if (!mira) return { ok: false, erro: 'sem alvo' };
    if (!mira.valido) return { ok: false, erro: mira.motivo ?? 'inválido' };

    const peca = this.peca;
    this._pagar(peca.custo);

    const evento = {
      tipo: 'construir',
      planeta: mira.planetaId,
      base: mira.base?.id ?? novoId(),
      // Só vai no primeiro evento de cada base; depois dela existir é redundante.
      frame: mira.frame
        ? { origem: mira.frame.origem.toArray(), quat: mira.frame.quat.toArray() }
        : null,
      cel: mira.cel,
      face: mira.face,
      peca: peca.id,
      giro: mira.giro,
    };

    this.aplicar(evento);
    return { ok: true, evento };
  }

  /**
   * Demole o que estiver sob a mira, devolvendo os recursos.
   * @returns {{ok:boolean, erro?:string, evento?:object}}
   */
  remover() {
    const mira = this.mira;
    if (!mira?.base) return { ok: false, erro: 'nada para demolir' };

    const existente = mira.base.pecas.get(mira.chave);
    if (!existente) return { ok: false, erro: 'nada para demolir' };

    const peca = PECA_POR_ID.get(existente.peca);
    // Devolve tudo. Cobrar taxa de demolição pune quem experimenta, que é
    // exatamente o comportamento que um editor de base precisa incentivar.
    if (peca) for (const [id, qtd] of Object.entries(peca.custo)) this.inventory.add(id, qtd);

    const evento = {
      tipo: 'demolir',
      planeta: mira.planetaId,
      base: mira.base.id,
      cel: mira.cel,
      face: mira.face,
    };

    this.aplicar(evento);
    return { ok: true, evento, nome: peca?.nome ?? existente.peca };
  }

  /**
   * Aplica um evento — local, de outro jogador ou vindo do banco.
   *
   * O MESMO caminho para os três casos é deliberado: um evento remoto que
   * passasse por outro código seria a primeira coisa a divergir do local, e a
   * divergência só apareceria com dois jogadores construindo ao mesmo tempo,
   * que é o cenário mais difícil de reproduzir.
   */
  aplicar(evento) {
    const planeta = this.starSystem.planets[evento.planeta];
    if (!planeta) return false;

    let base = this.bases.get(evento.base);

    if (evento.tipo === 'demolir') {
      if (!base) return false;
      const chave = `${evento.cel[0]},${evento.cel[1]},${evento.cel[2]},${evento.face}`;
      if (!base.pecas.delete(chave)) return false;
      this._recalcularNiveis(base);
      this._reconstruir(base);
      if (base.pecas.size === 0) {
        // Base desmontada: o platô some junto. Deixar a marca de terraplenagem
        // depois de a construção sumir seria uma cicatriz que ninguém pode
        // desfazer, porque não existe mais nada ali para demolir.
        this.starSystem.planets[base.planetaId]?.removerEdicao(base.id);
        this._aplanarPendente.delete(base.id);
        this._descartarBase(base);
      } else {
        this._aplanarPendente.add(base.id);
      }
      return true;
    }

    if (!base) {
      if (!evento.frame) return false; // base desconhecida e sem como criá-la
      base = this._criarBase(evento.base, evento.planeta, planeta, evento.frame);
    }

    const chave = `${evento.cel[0]},${evento.cel[1]},${evento.cel[2]},${evento.face}`;
    if (base.pecas.has(chave)) return false;

    base.pecas.set(chave, {
      peca: evento.peca,
      giro: evento.giro,
      cel: evento.cel,
      face: evento.face,
      /**
       * Idade da peça, em segundos, para a animação de surgimento.
       *
       * Peças restauradas do banco entram com a animação já terminada: ver a
       * base inteira brotar do chão a cada vez que se abre o jogo transformaria
       * um efeito de recompensa em ruído de carregamento.
       */
      idade: evento.animar === false ? DURACAO_SURGIMENTO : 0,
    });
    if (evento.animar !== false) this._animando = true;

    this._recalcularNiveis(base);
    this._reconstruir(base);
    this._aplanarPendente.add(base.id);
    return true;
  }

  /* ===================================================================== */
  /* Terreno sob a base                                                    */
  /* ===================================================================== */

  /**
   * Ajusta o platô de terreno sob uma base.
   *
   * ---------------------------------------------------------------------
   * POR QUE ISTO NÃO TRAFEGA PELA REDE
   * ---------------------------------------------------------------------
   * O platô é FUNÇÃO PURA das peças da base: mesma origem, mesmo contorno,
   * mesmo raio. Todo cliente que conhece a base calcula exatamente a mesma
   * deformação sozinho — é a mesma lógica que faz o terreno inteiro derivar do
   * seed sem trafegar. Mandar o platô junto seria transmitir algo que o outro
   * lado já sabe, e criaria uma segunda fonte de verdade para divergir da
   * primeira.
   *
   * Escavações feitas à mão (`Terraform`) são o oposto: não derivam de nada, e
   * por isso precisam ir para a rede e para o banco.
   */
  _aplainar(base) {
    if (base.pecas.size === 0) return;

    // Extensão da base em células, medida do centro da grade.
    let alcance = 0;
    for (const item of base.pecas.values()) {
      alcance = Math.max(alcance, Math.abs(item.cel[0]) + 0.5, Math.abs(item.cel[2]) + 0.5);
    }

    // Quantizado em células inteiras: sem isso, cada peça nova mexeria o raio
    // por uma fração e disparia a reconstrução de todos os chunks em volta.
    const raio = (Math.ceil(alcance) + FOLGA_PLATO) * ESCALA_CELULA;

    const planeta = this.starSystem.planets[base.planetaId];
    if (!planeta) return;

    _p.copy(base.origem);
    const distancia = _p.length();
    _p.divideScalar(distancia || 1);

    const edicao = {
      id: base.id,
      x: _p.x, y: _p.y, z: _p.z,
      r: raio,
      // A elevação alvo é a da própria placa. Como a origem já foi levantada até
      // o ponto mais alto da vizinhança (ver `_frameDaBase`), o platô sobe até
      // a base em vez de a base descer até o buraco.
      f: distancia - planeta.config.radius,
      t: EDICAO.NIVELAR,
    };

    planeta.aplicarEdicao(edicao);
  }

  /**
   * Passo por frame: platôs pendentes e animação de surgimento.
   *
   * Os platôs são adiados de propósito. Restaurar uma base de 200 peças chama
   * `aplicar` 200 vezes, e aplainar em cada uma delas descartaria e regeraria
   * os chunks da região 200 vezes seguidas — um congelamento de vários segundos
   * ao entrar na sala. Agrupando por frame, isso vira uma reconstrução só.
   */
  atualizar(dt) {
    if (this._aplanarPendente.size > 0) {
      for (const id of this._aplanarPendente) {
        const base = this.bases.get(id);
        if (base) this._aplainar(base);
      }
      this._aplanarPendente.clear();
    }

    if (!this._animando) return;

    this._animando = false;
    for (const base of this.bases.values()) {
      let mexeu = false;
      for (const item of base.pecas.values()) {
        if (item.idade >= DURACAO_SURGIMENTO) continue;
        item.idade = Math.min(DURACAO_SURGIMENTO, item.idade + dt);
        this._animando = this._animando || item.idade < DURACAO_SURGIMENTO;
        mexeu = true;
      }
      if (mexeu) this._reconstruir(base);
    }
  }

  /* ===================================================================== */
  /* Bases                                                                 */
  /* ===================================================================== */

  /**
   * Monta o referencial de uma base nova.
   *
   * Y é radial (o "para cima" daquele ponto do planeta) e Z é a direção do
   * olhar, projetada no plano tangente e ARREDONDADA para o múltiplo de 90°
   * mais próximo dos eixos do planeta. O arredondamento é o que faz duas bases
   * construídas na mesma região saírem alinhadas entre si — sem ele, cada base
   * nasceria com a inclinação acidental da cabeça do jogador.
   */
  _frameDaBase(planeta, pontoMundo, direcao) {
    const origem = pontoMundo.clone().sub(planeta.group.position);

    _eixoY.copy(origem).normalize();

    // --- Altura da placa ---------------------------------------------------
    // A base é PLANA e o terreno não é. Ancorá-la exatamente no ponto em que o
    // jogador clicou enterra metade do piso na primeira ondulação — foi o que
    // aconteceu no primeiro teste: um cômodo inteiro com areia por dentro.
    //
    // A saída é apoiar a placa no ponto MAIS ALTO da vizinhança que ela deve
    // cobrir, e não no ponto clicado. Num terreno plano isso não muda nada; numa
    // encosta a base passa a ficar sobre palafitas visíveis, que é o
    // comportamento honesto — dá para ver que o chão desce por baixo dela.
    //
    // O raio é o de um cômodo típico, não o da base inteira: quem constrói
    // encosta acima acaba encontrando terreno mais alto de qualquer forma, e
    // levantar a placa por causa de um morro a 100 m puniria todo mundo.
    const RAIO_AMOSTRA = 4 * ESCALA_CELULA;
    let maior = planeta.sampleAt(pontoMundo).surfaceRadius;

    _eixoZ.set(0, 1, 0);
    if (Math.abs(_eixoZ.dot(_eixoY)) > 0.95) _eixoZ.set(1, 0, 0);
    _eixoZ.addScaledVector(_eixoY, -_eixoZ.dot(_eixoY)).normalize();
    _eixoX.crossVectors(_eixoY, _eixoZ).normalize();

    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      _p.copy(pontoMundo)
        .addScaledVector(_eixoX, Math.cos(a) * RAIO_AMOSTRA)
        .addScaledVector(_eixoZ, Math.sin(a) * RAIO_AMOSTRA);
      maior = Math.max(maior, planeta.sampleAt(_p).surfaceRadius);
    }

    origem.copy(_eixoY).multiplyScalar(maior + 0.05);

    // Os eixos tangentes acima já servem de referência: eles vêm do planeta, e
    // não da câmera, que é o que faz duas bases da mesma região sair alinhadas.
    // Falta girá-los para a direção do olhar, arredondada a um quarto de volta.
    _p.copy(direcao).addScaledVector(_eixoY, -direcao.dot(_eixoY));
    const quarto =
      _p.lengthSq() < 1e-8 ? 0 : Math.round(Math.atan2(_p.dot(_eixoX), _p.dot(_eixoZ)) / (Math.PI / 2));

    _quat.setFromAxisAngle(_eixoY, quarto * (Math.PI / 2));
    _eixoZ.applyQuaternion(_quat).normalize();
    _eixoX.crossVectors(_eixoY, _eixoZ).normalize();

    _matriz.makeBasis(_eixoX, _eixoY, _eixoZ);
    return { origem, quat: new THREE.Quaternion().setFromRotationMatrix(_matriz) };
  }

  _criarBase(id, planetaId, planeta, frame) {
    const grupo = new THREE.Group();
    grupo.position.fromArray(Array.isArray(frame.origem) ? frame.origem : frame.origem.toArray());
    grupo.quaternion.fromArray(Array.isArray(frame.quat) ? frame.quat : frame.quat.toArray());
    grupo.scale.setScalar(ESCALA_CELULA);
    // No `group` do planeta, e não na cena: assim a base acompanha o planeta de
    // graça e a origem flutuante nunca precisa saber que ela existe — mesma
    // razão pela qual props e fauna vivem lá.
    planeta.group.add(grupo);
    grupo.updateMatrixWorld(true);

    const base = {
      id,
      planetaId,
      grupo,
      origem: grupo.position.clone(),
      quat: grupo.quaternion.clone(),
      /** @type {Map<string, {peca:string, giro:number, cel:number[], face:number}>} */
      pecas: new Map(),
      /** @type {Map<string, THREE.InstancedMesh>} */
      malhas: new Map(),
      /** Níveis (y) com alguma peça — usados pela mira. @type {number[]} */
      niveis: [0],
      inversa: new THREE.Matrix4(),
    };

    this.bases.set(id, base);
    this._atualizarMatrizes(base);
    return base;
  }

  /**
   * Recalcula a matriz mundo→base.
   *
   * Precisa rodar TODO FRAME, não só na criação: com origem flutuante o mundo
   * inteiro se desloca sob os pés do jogador, e uma inversa guardada de um
   * rebase atrás poria o fantasma a milhares de unidades da base.
   */
  _atualizarMatrizes(base) {
    base.grupo.updateWorldMatrix(true, false);
    base.inversa.copy(base.grupo.matrixWorld).invert();
  }

  _recalcularNiveis(base) {
    const niveis = new Set([0]);
    for (const p of base.pecas.values()) {
      niveis.add(p.cel[1]);
      // O nível seguinte também é mirável: é assim que se começa um andar novo.
      niveis.add(p.cel[1] + 1);
    }
    base.niveis = [...niveis].sort((a, b) => a - b);
  }

  _baseMaisProxima(planetaId, posicaoMundo) {
    let melhor = null;
    let menor = RAIO_DA_BASE * RAIO_DA_BASE;
    for (const base of this.bases.values()) {
      if (base.planetaId !== planetaId) continue;
      const d = base.grupo.getWorldPosition(_p).distanceToSquared(posicaoMundo);
      if (d < menor) {
        menor = d;
        melhor = base;
      }
    }
    return melhor;
  }

  _descartarBase(base) {
    for (const malha of base.malhas.values()) {
      malha.removeFromParent();
      malha.dispose();
    }
    base.grupo.removeFromParent();
    this.bases.delete(base.id);
  }

  /* ===================================================================== */
  /* Render                                                                */
  /* ===================================================================== */

  /**
   * Altura extra de um slot dentro da célula.
   *
   * Só a mobília tem: ela repousa SOBRE a laje, e a laje só existe se alguém
   * tiver construído o piso. Uma mesa no chão pelado fica no chão pelado.
   */
  _alturaDoSlot(base, cel, face) {
    if (face !== SLOT_MOBILIA) return 0;
    return base?.pecas.has(`${cel[0]},${cel[1]},${cel[2]},${SLOT_PISO}`) ? this.espessuraPiso : 0;
  }

  /** Transformação de uma peça dentro do espaço da base (unidades de célula). */
  _transformaDaPeca(alvo, cel, face, giro, dy = 0, escala = 1) {
    _quat.setFromAxisAngle(EIXO_Y, giro * (Math.PI / 2));

    const offset = face >= 0 ? OFFSET_BORDA[face] : null;
    alvo.compose(
      _p.set(
        cel[0] + (offset ? offset[0] : 0),
        cel[1] + dy + (offset ? offset[1] : 0),
        cel[2] + (offset ? offset[2] : 0)
      ),
      _quat,
      _q.set(escala, escala, escala)
    );
    return alvo;
  }

  /** Refaz os InstancedMesh de uma base. */
  _reconstruir(base) {
    /** @type {Map<string, object[]>} */
    const porTipo = new Map();
    for (const item of base.pecas.values()) {
      let lista = porTipo.get(item.peca);
      if (!lista) porTipo.set(item.peca, (lista = []));
      lista.push(item);
    }

    // Tipos que sumiram da base perdem a malha.
    for (const [id, malha] of base.malhas) {
      if (porTipo.has(id)) continue;
      malha.removeFromParent();
      malha.dispose();
      base.malhas.delete(id);
    }

    for (const [id, lista] of porTipo) {
      const geometria = this.geometrias.get(id);
      if (!geometria) continue;

      let malha = base.malhas.get(id);
      // `InstancedMesh` tem capacidade FIXA. Realocar a cada peça seria um
      // desperdício visível; a folga de 16 faz a malha ser refeita a cada 16
      // construções em vez de a cada uma.
      if (!malha || malha.instanceMatrix.count < lista.length) {
        malha?.removeFromParent();
        malha?.dispose();
        malha = new THREE.InstancedMesh(geometria, this.material, lista.length + 16);
        malha.castShadow = true;
        malha.receiveShadow = true;
        // A base é pequena perto do planeta e vive colada na câmera do jogador;
        // o culling por instância não compensa o custo da esfera envolvente.
        malha.frustumCulled = false;
        base.grupo.add(malha);
        base.malhas.set(id, malha);
      }

      for (let i = 0; i < lista.length; i++) {
        const item = lista[i];
        const t = Math.min(1, item.idade / DURACAO_SURGIMENTO);
        // Nasce achatada contra o chão e cresce. Escala zero deixaria a peça
        // invisível por um frame e a matriz singular; 0,04 evita as duas coisas.
        const escala = t >= 1 ? 1 : 0.04 + surgimento(t) * 0.96;
        this._transformaDaPeca(
          _matriz,
          item.cel,
          item.face,
          item.giro,
          this._alturaDoSlot(base, item.cel, item.face),
          escala
        );
        malha.setMatrixAt(i, _matriz);
      }
      malha.count = lista.length;
      malha.instanceMatrix.needsUpdate = true;
      malha.computeBoundingSphere();
    }
  }

  _mostrarFantasma(planeta, base, frame, cel, face, giro, valido) {
    const peca = this.peca;
    const geometria = this.geometrias.get(peca.id);
    if (!geometria) return this._esconderFantasma();

    if (!this._malhaFantasma || this._malhaFantasma.geometry !== geometria) {
      this._malhaFantasma?.removeFromParent();
      this._malhaFantasma = new THREE.Mesh(geometria, this.materialFantasma);
      this._malhaFantasma.frustumCulled = false;
      this._grupoFantasma.add(this._malhaFantasma);
    }

    // O fantasma segue o referencial da base alvo — ou o da base que ainda não
    // existe, que é justamente o que o jogador precisa ver antes de decidir.
    if (base) {
      this._grupoFantasma.position.copy(base.grupo.position);
      this._grupoFantasma.quaternion.copy(base.grupo.quaternion);
      if (this._grupoFantasma.parent !== base.grupo.parent) {
        base.grupo.parent.add(this._grupoFantasma);
      }
    } else if (frame) {
      this._grupoFantasma.position.copy(frame.origem);
      this._grupoFantasma.quaternion.copy(frame.quat);
      if (this._grupoFantasma.parent !== planeta.group) planeta.group.add(this._grupoFantasma);
    }

    this._transformaDaPeca(_matriz, cel, face, giro, this._alturaDoSlot(base, cel, face));
    _matriz.decompose(this._malhaFantasma.position, this._malhaFantasma.quaternion, this._malhaFantasma.scale);

    // A moldura marca a CÉLULA, não a peça: mostra onde o quadrado da grade
    // está mesmo quando a peça é uma cadeira que ocupa um terço dele.
    this._moldura.position.set(cel[0], cel[1] + 0.01, cel[2]);
    this._moldura.quaternion.identity();

    this._grupoFantasma.visible = true;
    const cor = valido ? 0x58e8ff : 0xff5a5a;
    this.materialFantasma.color.setHex(cor);
    this.materialFantasma.emissive.setHex(valido ? 0x1d6b7d : 0x6b1d1d);
    this._moldura.material.color.setHex(cor);
  }

  _esconderFantasma() {
    this._grupoFantasma.visible = false;
  }

  /* ===================================================================== */
  /* Colisão                                                               */
  /* ===================================================================== */

  /**
   * Empurra o jogador para fora das peças sólidas.
   *
   * Roda DEPOIS de `PlayerController.update()`, sobre a posição já resolvida
   * contra o terreno. É o preço de manter o controlador ignorante da
   * construção: ele resolve a esfera, isto resolve as caixas, e nenhum dos dois
   * precisa saber do outro.
   *
   * O teste roda no espaço da base, onde tudo é alinhado aos eixos e a colisão
   * cilindro-contra-caixa cabe em vinte linhas. Em espaço de mundo cada parede
   * seria uma caixa orientada e exigiria SAT.
   *
   * @param {import('../controls/PlayerController.js').PlayerController} jogador
   */
  resolverColisao(jogador) {
    if (this.bases.size === 0) return;

    const raio = RAIO_JOGADOR / ESCALA_CELULA;
    const altura = ALTURA_JOGADOR / ESCALA_CELULA;

    for (const base of this.bases.values()) {
      this._atualizarMatrizes(base);

      _local.copy(jogador.position).applyMatrix4(base.inversa);
      // Longe da base: nem vale percorrer as peças.
      if (Math.abs(_local.x) > 64 || Math.abs(_local.z) > 64 || Math.abs(_local.y) > 32) continue;

      const cx = Math.round(_local.x);
      const cy = Math.round(_local.y);
      const cz = Math.round(_local.z);

      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          for (let dz = -2; dz <= 2; dz++) {
            for (const face of SLOTS) {
              const item = base.pecas.get(`${cx + dx},${cy + dy},${cz + dz},${face}`);
              if (!item) continue;
              const peca = PECA_POR_ID.get(item.peca);
              if (!peca?.caixa || (!peca.solido && !peca.apoio)) continue;
              this._empurrar(base, jogador, item, peca, raio, altura);
            }
          }
        }
      }
    }
  }

  /** Um passo de separação contra uma peça. */
  _empurrar(base, jogador, item, peca, raio, altura) {
    this._transformaDaPeca(
      _matriz,
      item.cel,
      item.face,
      item.giro,
      this._alturaDoSlot(base, item.cel, item.face)
    );

    // Rotação de múltiplo de 90° em torno de Y: a caixa continua alinhada aos
    // eixos, só troca X por Z quando o giro é ímpar. É o que permite pular a
    // matemática de caixa orientada por completo.
    const c = peca.caixa;
    const impar = item.giro % 2 === 1;
    const minX = impar ? c.min[2] : c.min[0];
    const maxX = impar ? c.max[2] : c.max[0];
    const minZ = impar ? c.min[0] : c.min[2];
    const maxZ = impar ? c.max[0] : c.max[2];

    _p.setFromMatrixPosition(_matriz);

    // Envelope da caixa inflado pelo raio do jogador (Minkowski): o problema
    // vira "um PONTO está dentro desta caixa maior?".
    const bx0 = _p.x + minX - raio;
    const bx1 = _p.x + maxX + raio;
    const bz0 = _p.z + minZ - raio;
    const bz1 = _p.z + maxZ + raio;
    const by0 = _p.y + c.min[1] - altura;
    const by1 = _p.y + c.max[1];

    _local.copy(jogador.position).applyMatrix4(base.inversa);
    if (
      _local.x <= bx0 || _local.x >= bx1 ||
      _local.y <= by0 || _local.y >= by1 ||
      _local.z <= bz0 || _local.z >= bz1
    ) {
      return;
    }

    // Sai pelo lado mais próximo. Escolher o menor deslocamento é o que faz
    // encostar numa parede deslizar em vez de teleportar para o outro lado.
    const px = Math.min(_local.x - bx0, bx1 - _local.x);
    const py = Math.min(_local.y - by0, by1 - _local.y);
    const pz = Math.min(_local.z - bz0, bz1 - _local.z);

    _correcao.set(0, 0, 0);
    if (py <= px && py <= pz) {
      const subindo = by1 - _local.y <= _local.y - by0;
      _correcao.y = subindo ? by1 - _local.y : by0 - _local.y;
    } else if (px <= pz) {
      _correcao.x = _local.x - bx0 <= bx1 - _local.x ? bx0 - _local.x : bx1 - _local.x;
    } else {
      _correcao.z = _local.z - bz0 <= bz1 - _local.z ? bz0 - _local.z : bz1 - _local.z;
    }

    // De volta ao mundo: só rotação e escala, nunca a translação.
    const pisou = _correcao.y > 0;
    _correcao.applyQuaternion(base.grupo.quaternion).multiplyScalar(ESCALA_CELULA);
    jogador.position.add(_correcao);

    // Mata a velocidade que entrava na peça; a tangencial sobrevive, senão
    // raspar numa parede pararia o jogador em seco.
    const normal = _q.copy(_correcao).normalize();
    const entrando = jogador.velocity.dot(normal);
    if (entrando < 0) jogador.velocity.addScaledVector(normal, -entrando);

    // Pousar em cima de um piso conta como estar no chão — sem isto o jetpack
    // nunca recarrega dentro da própria base e o pulo não funciona.
    if (pisou) jogador.grounded = true;
  }

  /* ===================================================================== */
  /* Recursos                                                              */
  /* ===================================================================== */

  _podePagar(custo) {
    for (const [id, qtd] of Object.entries(custo)) {
      if (this.inventory.count(id) < qtd) return false;
    }
    return true;
  }

  _pagar(custo) {
    for (const [id, qtd] of Object.entries(custo)) this.inventory.remove(id, qtd);
  }

  /* ===================================================================== */
  /* Estado                                                                */
  /* ===================================================================== */

  /** Todas as peças de todas as bases, para o servidor ou o banco. */
  serializar() {
    const saida = [];
    for (const base of this.bases.values()) {
      for (const item of base.pecas.values()) {
        saida.push({
          tipo: 'construir',
          planeta: base.planetaId,
          base: base.id,
          frame: { origem: base.origem.toArray(), quat: base.quat.toArray() },
          cel: item.cel,
          face: item.face,
          peca: item.peca,
          giro: item.giro,
        });
      }
    }
    return saida;
  }

  get totalPecas() {
    let total = 0;
    for (const base of this.bases.values()) total += base.pecas.size;
    return total;
  }

  /**
   * Descarta todas as bases sem tocar no terreno.
   *
   * Usado no salto interestelar. Diferente de demolir: as peças não são
   * devolvidas ao inventário e o platô não é desfeito, porque nada foi
   * destruído — o jogador apenas saiu do sistema, e a base continua lá para
   * quando ele voltar. O que se apaga é a CÓPIA em memória, que pertence a um
   * universo que não está mais na cena.
   */
  esquecerTudo() {
    for (const base of [...this.bases.values()]) this._descartarBase(base);
    this._aplanarPendente.clear();
    this._animando = false;
  }

  dispose() {
    for (const base of [...this.bases.values()]) this._descartarBase(base);
    this._grupoFantasma.removeFromParent();
    this.material?.dispose();
    this.materialFantasma?.dispose();
    for (const g of this.geometrias.values()) g.dispose();
  }
}
