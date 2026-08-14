/**
 * HUD em HTML/CSS sobre o canvas.
 *
 * POR QUE NÃO DESENHAR NO CANVAS: texto em WebGL exige atlas de fontes,
 * geometria por glifo e um draw call por painel — e fica pior em telas HiDPI.
 * O compositor do browser desenha DOM na GPU de graça, com antialiasing
 * subpixel nativo. O único cuidado é o custo de escrita no DOM.
 *
 * POR ISSO O THROTTLE: atualizar 20 elementos a 144 Hz é layout thrashing puro.
 * O texto vai a 10 Hz (imperceptível para números) e só as barras e marcadores,
 * que usam `width`/`transform` e não causam reflow, acompanham o frame.
 */

import * as THREE from 'three';

const TEXT_INTERVAL = 0.1; // segundos
/** 2*pi*r do círculo do retículo (r = 16). */
const RETICLE_CIRCUMFERENCE = 100.5;

const _projected = new THREE.Vector3();

export class HUD {
  constructor() {
    const el = (id) => document.getElementById(id);

    this.root = el('hud');
    this.banner = el('hud-banner');
    this.prompt = el('prompt');
    this.miningArc = el('mining-arc');
    this.markerRoot = el('markers');

    this.discovery = {
      root: el('discovery'),
      name: el('disc-name'),
      sub: el('disc-sub'),
      units: el('disc-units'),
    };

    this.fields = {
      speed: el('hud-speed'),
      altitude: el('hud-altitude'),
      state: el('hud-state'),
      planet: el('hud-planet'),
      class: el('hud-class'),
      biome: el('hud-biome'),
      fauna: el('hud-fauna'),
      lat: el('hud-lat'),
      lon: el('hud-lon'),
      catalog: el('hud-catalog'),
      fps: el('hud-fps'),
      chunks: el('hud-chunks'),
      queue: el('hud-queue'),
      props: el('hud-props'),
      cache: el('hud-cache'),
      units: el('hud-units'),
      slots: el('hud-slots'),
    };

    this.bars = {
      throttle: el('hud-throttle'),
      jetpack: el('hud-jetpack'),
      shield: el('hud-shield'),
      atmo: el('hud-atmo'),
    };

    this.meters = {
      throttle: el('meter-throttle'),
      jetpack: el('meter-jetpack'),
    };

    this.itemList = el('hud-items');

    this.room = {
      root: el('hud-room'),
      count: el('room-count'),
      list: el('room-list'),
      /** Última lista desenhada, para não reconstruir DOM a cada frame. */
      assinatura: '',
    };

    this.build = {
      root: el('buildbar'),
      list: el('build-list'),
      name: el('build-name'),
      cost: el('build-cost'),
      /** Itens da tira, criados uma vez. @type {HTMLElement[]} */
      chips: [],
      selecionado: -1,
      assinatura: '',
    };

    this.hotbar = { root: el('hotbar'), list: el('hotbar-list'), chips: [], atual: -1 };

    this.painel = {
      root: el('painel'),
      abas: [...document.querySelectorAll('.painel-abas button')],
      secoes: {
        inventario: el('aba-inventario'),
        construcao: el('aba-construcao'),
      },
      units: el('painel-units'),
      slots: el('painel-slots'),
      grade: el('painel-grade'),
      categorias: el('catalogo-categorias'),
      pecas: el('catalogo-pecas'),
      aba: 'inventario',
      categoria: null,
      montado: false,
      assinatura: '',
    };

    this.mapa = {
      root: el('mapa'),
      galaxia: el('mapa-galaxia'),
      visitados: el('mapa-visitados'),
      alcance: el('mapa-alcance'),
      estrelas: el('mapa-estrelas'),
      ficha: el('mapa-ficha'),
      tag: el('ficha-tag'),
      nome: el('ficha-nome'),
      endereco: el('ficha-endereco'),
      classe: el('ficha-classe'),
      planetas: el('ficha-planetas'),
      distancia: el('ficha-distancia'),
      acao: el('ficha-acao'),
      assinatura: '',
    };

    this._accumulator = 0;
    this._bannerTimer = 0;
    this._discoveryTimer = 0;
    this._cache = {};
    this._itemsSignature = '';
    /** @type {Map<string, HTMLElement>} */
    this._markers = new Map();
  }

  show() {
    this.root.classList.remove('hidden');
  }

  /** Escreve só se o valor mudou — evita invalidar layout à toa. */
  _set(key, value) {
    if (this._cache[key] === value) return;
    this._cache[key] = value;
    this.fields[key].textContent = value;
  }

  /**
   * @param {number} dt
   * @param {object} data
   */
  update(dt, data) {
    // Barras e anel: `width`/`stroke-dashoffset` num elemento posicionado não
    // disparam reflow do documento, então podem rodar a cada frame.
    this.bars.throttle.style.width = `${(data.throttle * 100).toFixed(0)}%`;
    this.bars.jetpack.style.width = `${(data.jetpack * 100).toFixed(0)}%`;
    this.bars.shield.style.width = `${(data.shield * 100).toFixed(0)}%`;
    this.bars.atmo.style.width = `${(data.atmosphere * 100).toFixed(0)}%`;

    this.miningArc.style.strokeDashoffset =
      RETICLE_CIRCUMFERENCE * (1 - data.miningProgress);

    // Só o medidor relevante ao modo atual fica visível.
    this.meters.throttle.classList.toggle('off', data.onFoot);
    this.meters.jetpack.classList.toggle('off', !data.onFoot);

    if (this._bannerTimer > 0) {
      this._bannerTimer -= dt;
      if (this._bannerTimer <= 0) this.banner.classList.remove('show');
    }
    if (this._discoveryTimer > 0) {
      this._discoveryTimer -= dt;
      if (this._discoveryTimer <= 0) this.discovery.root.classList.add('hidden');
    }

    this._accumulator += dt;
    if (this._accumulator < TEXT_INTERVAL) return;
    this._accumulator = 0;

    this._set('speed', data.speed.toFixed(0));
    this._set('altitude', formatDistance(data.altitude));
    this._set('state', data.phase);
    this._set('planet', data.planetName);
    this._set('class', data.planetClass);
    this._set('biome', data.biome);
    // Fora do alcance da fauna o campo mostra "—" em vez de "0": zero sugere um
    // mundo estéril, quando a verdade é que ainda estamos alto demais para ver.
    this._set('fauna', data.faunaAtiva ? `${data.fauna} · ${data.faunaEspecies}` : '—');
    this._set('lat', `${data.latitude.toFixed(1)}°`);
    this._set('lon', `${data.longitude.toFixed(1)}°`);
    this._set('catalog', data.cataloged ? 'REGISTRADO' : 'DESCONHECIDO');
    this._set('fps', data.fps.toFixed(0));
    this._set('chunks', String(data.chunks));
    this._set('queue', String(data.queue));
    this._set('props', formatCount(data.props));
    this._set('cache', `${(data.cacheHitRate * 100).toFixed(0)}%`);
    this._set('units', data.units.toLocaleString('pt-BR'));
    this._set('slots', `${data.slotsUsed}/${data.slots}`);

    this._renderItems(data.items);
  }

  _renderItems(items) {
    // Reconstruir a lista é barato, mas só quando ela muda de verdade —
    // caso contrário seriam 10 recriações de DOM por segundo à toa.
    const signature = items.map((i) => `${i.id}:${i.amount}`).join('|');
    if (signature === this._itemsSignature) return;
    this._itemsSignature = signature;

    if (items.length === 0) {
      this.itemList.innerHTML = '<li class="empty">vazio</li>';
      return;
    }

    this.itemList.innerHTML = items
      .map((item) => {
        const hex = `#${item.cor.toString(16).padStart(6, '0')}`;
        return `<li><span class="dot" style="background:${hex}"></span>${item.nome}<span class="qty">${item.amount}</span></li>`;
      })
      .join('');
  }

  /* ===================================================================== */
  /* Marcadores no espaço da tela                                          */
  /* ===================================================================== */

  /**
   * Projeta pontos do mundo para a tela. É o que permite achar a nave depois
   * de caminhar 300 m e escolher para qual planeta viajar sem abrir um mapa.
   *
   * @param {THREE.Camera} camera
   * @param {Array<{id:string, position:THREE.Vector3, label:string, sub:string, kind:string}>} list
   */
  /**
   * Painel da sala: quem está online, onde e a que distância.
   *
   * O texto inteiro é remontado só quando MUDA. A lista roda a 60 Hz e trocar
   * `innerHTML` a cada frame descartaria e recriaria os nós — o que, além de
   * caro, mata a seleção de texto e faz o navegador reflowar a tela toda.
   * Comparar uma assinatura de string custa quase nada e evita tudo isso.
   *
   * @param {{nome:string, distancia:number|null, local:string, eu:boolean}[]} jogadores
   */
  updateRoom(sala) {
    if (!sala) {
      this.room.root.classList.add('hidden');
      return;
    }

    const { estado, jogadores } = sala;
    this.room.root.classList.remove('hidden');

    // O contador mostra o ESTADO quando não há sala. Antes o painel inteiro
    // ficava escondido enquanto não conectasse — e quem abria o jogo sem
    // servidor no ar não via nada, nem soube que existia um multijogador para
    // ligar. "Nenhum jogador" e "não estou vendo a sala" são coisas
    // diferentes, e a interface tem de saber dizer qual é qual.
    this.room.count.textContent =
      estado === 'online' ? String(jogadores.length) : estado === 'conectando' ? '…' : 'OFFLINE';

    const assinatura = estado + jogadores.map((j) => `${j.nome}|${j.local}`).join(';');
    if (assinatura === this.room.assinatura) return;
    this.room.assinatura = assinatura;

    if (estado !== 'online') {
      this.room.list.innerHTML =
        '<li class="offline"><span class="quem">sala indisponível</span><span class="onde">npm run mp</span></li>';
      return;
    }

    this.room.list.innerHTML = jogadores
      .map((jogador) => {
        const classes = [jogador.eu ? 'eu' : '', jogador.longe ? 'longe' : ''].filter(Boolean).join(' ');
        return `<li class="${classes}"><span class="quem">${escapar(jogador.nome)}</span><span class="onde">${escapar(jogador.local)}</span></li>`;
      })
      .join('');
  }

  /**
   * Barra de construção.
   *
   * A tira de peças é criada UMA vez, na primeira chamada, e depois só troca de
   * classe. Recriá-la por frame seria refazer 15 nós de DOM a 60 Hz para mudar
   * uma borda de cor.
   *
   * @param {{ativo:boolean, pecas:Array, selecao:number, custo:string,
   *          valido:boolean, motivo:string|null}|null} estado
   */
  updateBuild(estado) {
    if (!estado?.ativo) {
      this.build.root.classList.add('hidden');
      return;
    }
    this.build.root.classList.remove('hidden');

    if (this.build.chips.length === 0) {
      this.build.list.innerHTML = estado.pecas
        .map((p, i) => `<li data-i="${i}"><i>${i < 9 ? i + 1 : ''}</i>${escapar(p.nome)}</li>`)
        .join('');
      this.build.chips = [...this.build.list.children];
    }

    if (this.build.selecionado !== estado.selecao) {
      this.build.chips[this.build.selecionado]?.classList.remove('sel');
      this.build.chips[estado.selecao]?.classList.add('sel');
      this.build.selecionado = estado.selecao;
      // Mantém a peça escolhida visível quando a tira passa da largura da tela.
      this.build.chips[estado.selecao]?.scrollIntoView({ block: 'nearest', inline: 'center' });
    }

    // O motivo da recusa entra no lugar do custo: "ocupado" e "recursos
    // insuficientes" são as duas únicas perguntas que o jogador faz ao ver o
    // fantasma vermelho, e responder na mesma linha evita mais um aviso na tela.
    const texto = estado.valido ? estado.custo : (estado.motivo ?? estado.custo);
    const assinatura = `${estado.selecao}|${texto}|${estado.valido}`;
    if (assinatura === this.build.assinatura) return;
    this.build.assinatura = assinatura;

    this.build.name.textContent = estado.pecas[estado.selecao]?.nome ?? '—';
    this.build.cost.textContent = texto;
    this.build.cost.classList.toggle('erro', !estado.valido);
  }

  /* ===================================================================== */
  /* Barra de equipamento                                                  */
  /* ===================================================================== */

  updateHotbar(estado) {
    if (!estado) {
      this.hotbar.root.classList.add('hidden');
      return;
    }
    this.hotbar.root.classList.remove('hidden');

    if (this.hotbar.chips.length === 0) {
      this.hotbar.list.innerHTML = estado.ferramentas
        .map(
          (f, i) =>
            `<li style="--cor:#${f.cor.toString(16).padStart(6, '0')}"><i>${i + 1}</i><span>${escapar(f.nome)}</span></li>`
        )
        .join('');
      this.hotbar.chips = [...this.hotbar.list.children];
    }

    if (this.hotbar.atual !== estado.atual) {
      this.hotbar.chips[this.hotbar.atual]?.classList.remove('sel');
      this.hotbar.chips[estado.atual]?.classList.add('sel');
      this.hotbar.atual = estado.atual;
    }
  }

  /* ===================================================================== */
  /* Mapa galáctico                                                        */
  /* ===================================================================== */

  /**
   * Abre o mapa e esconde o HUD de voo.
   *
   * Os dois juntos seriam ruído puro: velocidade, altitude e bioma não querem
   * dizer nada enquanto se olha para uma galáxia, e as caixas do HUD tapariam
   * justamente os cantos onde a ficha do sistema precisa caber.
   */
  mostrarMapa(aberto) {
    this.mapa.root.classList.toggle('hidden', !aberto);
    this.root.classList.toggle('oculto-por-mapa', aberto);
  }

  atualizarMapa(estado) {
    const m = this.mapa;
    m.galaxia.textContent = estado.galaxia;
    m.visitados.textContent = String(estado.visitados);
    m.alcance.textContent = String(estado.alcance);
    m.estrelas.textContent = estado.estrelas.toLocaleString('pt-BR');

    const f = estado.ficha;
    if (!f) {
      m.ficha.classList.add('hidden');
      return;
    }
    m.ficha.classList.remove('hidden');

    // Assinatura: o mapa roda a 60 Hz e a ficha só muda quando o cursor troca
    // de estrela. Sem ela seriam nove escritas de DOM por frame para reescrever
    // exatamente o mesmo texto.
    const assinatura = `${f.endereco}|${f.alcancavel}|${f.atual}|${f.visitado}`;
    if (assinatura === m.assinatura) return;
    m.assinatura = assinatura;

    m.nome.textContent = f.nome;
    m.endereco.textContent = f.endereco;
    m.classe.textContent = `${f.classe} · ${nomeDaClasse(f.classe)}`;
    m.planetas.textContent = String(f.planetas);
    m.distancia.textContent = f.atual ? '—' : `${f.distancia.toFixed(2)} al`;

    m.tag.textContent = f.atual ? 'VOCÊ ESTÁ AQUI' : f.visitado ? 'JÁ VISITADO' : 'NÃO EXPLORADO';
    m.tag.className = `ficha-tag${f.atual ? ' atual' : f.visitado ? ' visitado' : ''}`;

    const acao = f.atual
      ? 'sistema atual'
      : f.alcancavel
        ? 'ENTER ou duplo clique para saltar'
        : 'fora do alcance do hiperimpulsor';
    m.acao.textContent = acao;
    m.acao.classList.toggle('bloqueado', !f.atual && !f.alcancavel);
  }

  /* ===================================================================== */
  /* Painel                                                                */
  /* ===================================================================== */

  /**
   * Liga os cliques do painel.
   *
   * Recebe callbacks em vez de tocar no jogo direto: o HUD não conhece
   * `BuildSystem` nem `Inventory`, e mantê-lo assim é o que impede a interface
   * de virar um segundo lugar onde regras de jogo moram.
   */
  ligarPainel({ aoEscolherPeca }) {
    for (const botao of this.painel.abas) {
      botao.addEventListener('click', () => this._trocarAba(botao.dataset.aba));
    }
    this.painel.pecas.addEventListener('click', (evento) => {
      const item = evento.target.closest('li[data-i]');
      if (!item || item.classList.contains('indisponivel')) return;
      aoEscolherPeca(Number(item.dataset.i));
    });
    this.painel.categorias.addEventListener('click', (evento) => {
      const item = evento.target.closest('li[data-cat]');
      if (!item) return;
      this.painel.categoria = item.dataset.cat;
      this.painel.assinatura = ''; // força o redesenho da lista
    });
  }

  _trocarAba(aba) {
    this.painel.aba = aba;
    for (const botao of this.painel.abas) {
      botao.classList.toggle('sel', botao.dataset.aba === aba);
    }
    for (const [nome, secao] of Object.entries(this.painel.secoes)) {
      secao.classList.toggle('hidden', nome !== aba);
    }
  }

  mostrarPainel(aberto) {
    this.painel.root.classList.toggle('hidden', !aberto);
  }

  /**
   * Redesenha o painel aberto.
   *
   * Roda a 60 Hz enquanto o painel está na tela, então tudo passa por uma
   * assinatura: sem ela seriam 27 cartões de peça recriados por frame só para
   * a contagem de ferrite continuar a mesma.
   */
  atualizarPainel({ inventario, build, recursos }) {
    const porId = new Map(recursos.map((r) => [r.id, r]));

    if (!this.painel.montado) {
      this._montarCatalogo(build, porId);
      this.painel.montado = true;
    }

    const itens = inventario.entries();
    const assinatura =
      `${this.painel.categoria}|${inventario.units}|${build.selecao}|` +
      itens.map((i) => `${i.id}:${i.amount}`).join(',');
    if (assinatura === this.painel.assinatura) return;
    this.painel.assinatura = assinatura;

    this.painel.units.textContent = inventario.units.toLocaleString('pt-BR');
    this.painel.slots.textContent = `${inventario.slotsUsed}/${inventario.slots}`;

    // --- Grade do inventário ------------------------------------------------
    // Slots vazios entram como células mudas. Mostrar só o que existe esconde a
    // informação mais útil do painel: quanto espaço ainda cabe.
    const celulas = [];
    for (const item of itens) {
      const recurso = porId.get(item.id);
      celulas.push(
        `<li class="slot cheio">
           <img src="${import.meta.env.BASE_URL}icons/${recurso?.icone ?? ''}" alt="" width="48" height="48" />
           <span class="slot-nome">${escapar(item.nome)}</span>
           <span class="slot-qtd">${item.amount}</span>
           <span class="slot-pilha">${item.stacks} pilha${item.stacks > 1 ? 's' : ''}</span>
         </li>`
      );
    }
    for (let i = celulas.length; i < inventario.slots; i++) {
      celulas.push('<li class="slot vazio"></li>');
    }
    this.painel.grade.innerHTML = celulas.join('');

    this._pintarPecas(build, porId);
  }

  _montarCatalogo(build, porId) {
    const categorias = build.categorias;
    this.painel.categoria = this.painel.categoria ?? categorias[0]?.id;
    this.painel.categorias.innerHTML = categorias
      .map((c) => `<li data-cat="${c.id}"><b>${escapar(c.nome)}</b><i>${escapar(c.resumo)}</i></li>`)
      .join('');
  }

  _pintarPecas(build, porId) {
    for (const item of this.painel.categorias.children) {
      item.classList.toggle('sel', item.dataset.cat === this.painel.categoria);
    }

    const lista = build.pecas
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.categoria === this.painel.categoria);

    this.painel.pecas.innerHTML = lista
      .map(({ p, i }) => {
        const custo = Object.entries(p.custo)
          .map(([id, qtd]) => {
            const recurso = porId.get(id);
            const tem = build.inventory.count(id);
            const falta = tem < qtd;
            return `<span class="custo${falta ? ' falta' : ''}" title="${escapar(recurso?.nome ?? id)}">
                      <img src="${import.meta.env.BASE_URL}icons/${recurso?.icone ?? ''}" alt="${escapar(recurso?.nome ?? id)}" width="20" height="20" />
                      <b>${tem}</b>/<i>${qtd}</i>
                    </span>`;
          })
          .join('');

        const disponivel = Object.entries(p.custo).every(([id, qtd]) => build.inventory.count(id) >= qtd);
        const classes = [
          i === build.selecao ? 'sel' : '',
          disponivel ? '' : 'indisponivel',
        ].filter(Boolean).join(' ');

        return `<li data-i="${i}" class="${classes}">
                  <img class="miniatura" src="${build.miniatura(p.id)}" alt="" />
                  <span class="peca-nome">${escapar(p.nome)}</span>
                  <span class="peca-custo">${custo}</span>
                </li>`;
      })
      .join('');
  }

  updateMarkers(camera, list) {
    const seen = new Set();
    const halfW = window.innerWidth / 2;
    const halfH = window.innerHeight / 2;

    for (const item of list) {
      _projected.copy(item.position).project(camera);

      // ---------------------------------------------------------------------
      // ATRÁS DA CÂMERA (z > 1): ESPELHAR, NÃO ESCONDER.
      //
      // A projeção de um ponto atrás do olho sai invertida — usá-la crua põe o
      // marcador no lado errado da tela. A versão anterior simplesmente
      // descartava esses pontos, e o efeito era o oposto do que um marcador
      // serve: o companheiro sumia da interface exatamente quando você virava
      // de costas para ele, que é quando você mais precisa saber para onde
      // voltar. E o rótulo congelava com a última distância vista.
      //
      // Negar as coordenadas desfaz a inversão; o clamp abaixo encosta o
      // marcador na borda do lado certo.
      // ---------------------------------------------------------------------
      const atras = _projected.z > 1;
      if (atras) {
        _projected.x = -_projected.x;
        _projected.y = -_projected.y;
      }

      const x = (_projected.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-_projected.y * 0.5 + 0.5) * window.innerHeight;

      // Mantém o marcador dentro da tela, com uma margem, para não sumir
      // exatamente quando o jogador precisa dele. Quem está atrás vai
      // obrigatoriamente para a borda: um alvo às suas costas desenhado no meio
      // da tela seria uma mentira.
      const cx = atras
        ? (x < window.innerWidth / 2 ? 40 : window.innerWidth - 40)
        : Math.max(40, Math.min(window.innerWidth - 40, x));
      const cy = Math.max(30, Math.min(window.innerHeight - 30, y));

      let node = this._markers.get(item.id);
      if (!node) {
        node = document.createElement('div');
        node.className = `marker marker--${item.kind}`;
        node.innerHTML = '<span class="glyph"></span><span class="label"></span><span class="dist"></span>';
        this.markerRoot.appendChild(node);
        this._markers.set(item.id, node);
      }

      node.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
      const label = node.querySelector('.label');
      const dist = node.querySelector('.dist');
      if (label.textContent !== item.label) label.textContent = item.label;
      if (dist.textContent !== item.sub) dist.textContent = item.sub;
      // Mais apagado quando está atrás: distingue "está ali" de "está para
      // aquele lado" sem precisar de outro glifo.
      node.style.opacity = atras ? '0.45' : '1';
      seen.add(item.id);
    }

    for (const [id, node] of this._markers) {
      if (!seen.has(id)) node.style.opacity = '0';
    }
  }

  /* ===================================================================== */
  /* Mensagens                                                             */
  /* ===================================================================== */

  /** Prompt contextual (`null` esconde). */
  setPrompt(html) {
    if (!html) {
      this.prompt.classList.add('hidden');
      return;
    }
    if (this.prompt.innerHTML !== html) this.prompt.innerHTML = html;
    this.prompt.classList.remove('hidden');
  }

  /** Mensagem temporária no centro da tela. */
  notify(text, duration = 2.6) {
    this.banner.textContent = text;
    this.banner.classList.add('show');
    this._bannerTimer = duration;
  }

  /** Cartão de descoberta. */
  showDiscovery(nome, subtitulo, unidades, duration = 4.5) {
    this.discovery.name.textContent = nome;
    this.discovery.sub.textContent = subtitulo;
    this.discovery.units.textContent = `+${unidades.toLocaleString('pt-BR')} unidades`;
    this.discovery.root.classList.remove('hidden');
    this._discoveryTimer = duration;
  }
}

function formatDistance(value) {
  const abs = Math.abs(value);
  if (abs >= 100000) return `${(value / 1000).toFixed(0)}k`;
  if (abs >= 10000) return `${(value / 1000).toFixed(1)}k`;
  return value.toFixed(0);
}

/**
 * Escapa texto vindo de OUTRO jogador antes de ir para `innerHTML`.
 *
 * O nome chega pela rede e é escolhido por um desconhecido: sem isto, alguém
 * entra na sala com um `<img onerror=...>` no nome e executa script na sua
 * máquina. O servidor já corta o tamanho, mas confiar nele seria depender de
 * uma validação que mora do outro lado do fio.
 */
function escapar(texto) {
  return String(texto).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/** Como o jogador lê a classe espectral — a letra sozinha não diz nada. */
function nomeDaClasse(letra) {
  return {
    O: 'azul, hipergigante', B: 'azul-branca', A: 'branca', F: 'branco-amarela',
    G: 'amarela', K: 'laranja', M: 'anã vermelha',
  }[letra] ?? 'desconhecida';
}

function formatCount(value) {
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(value);
}

/**
 * Converte uma direção unitária em latitude/longitude (graus).
 * Y é o eixo polar do planeta, coerente com `temperatureAt` em terrain.js.
 */
export function toLatLon(direction) {
  const latitude = Math.asin(Math.max(-1, Math.min(1, direction.y))) * (180 / Math.PI);
  const longitude = Math.atan2(direction.z, direction.x) * (180 / Math.PI);
  return { latitude, longitude };
}
