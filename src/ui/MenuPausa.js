/**
 * Menu de pausa e opções gráficas.
 *
 * ===========================================================================
 * POR QUE ISTO NÃO MORA NO `HUD`
 * ===========================================================================
 * O HUD é uma camada de LEITURA: painéis sem captura de clique, atualizados a
 * cada quadro a partir de um objeto de estado. Este menu é o oposto — recebe
 * clique, tem estado próprio, e escreve em preferências que persistem entre
 * sessões. Enfiá-lo lá dentro faria o arquivo do HUD acumular a única parte da
 * interface que não segue nenhuma das suas regras.
 *
 * ===========================================================================
 * O QUE ELE MOSTRA JUNTO COM AS OPÇÕES
 * ===========================================================================
 * Uma linha com o custo medido em milissegundos de GPU. Sem ela, opções
 * gráficas são adivinhação: o jogador mexe num controle e não tem como saber se
 * ajudou. Com ela, "escala 0,6" deixa de ser um número abstrato e vira "3,1 ms
 * em vez de 5,7".
 */

const PREDEF_ORDEM = ['desempenho', 'equilibrado', 'alto'];

export class MenuPausa {
  /**
   * @param {import('../game/Qualidade.js').Qualidade} qualidade
   * @param {object} deps
   * @param {() => void} deps.aoFechar
   * @param {() => Promise<number|null>} [deps.medir] custo de GPU, se disponível
   * @param {string[]} deps.niveisDeNuvem
   */
  constructor(qualidade, { aoFechar, medir, niveisDeNuvem }) {
    this.q = qualidade;
    this.medir = medir;
    this.niveisDeNuvem = niveisDeNuvem;
    this.aberto = false;

    const el = (id) => document.getElementById(id);
    this.raiz = el('pausa');
    this.campos = {
      predef: el('op-predef'),
      escala: el('op-escala'),
      escalaValor: el('op-escala-valor'),
      ratio: el('op-ratio'),
      ratioValor: el('op-ratio-valor'),
      nuvens: el('op-nuvens'),
      sombras: el('op-sombras'),
      pos: el('op-pos'),
      detalhe: el('op-detalhe'),
      medida: el('pausa-medida'),
      voltar: el('pausa-voltar'),
    };

    this._aoFechar = aoFechar;
    this._montar();
    this._sincronizar();
  }

  _montar() {
    const c = this.campos;

    // --- Predefinições ---------------------------------------------------
    for (const nome of PREDEF_ORDEM) {
      const b = document.createElement('button');
      b.dataset.predef = nome;
      b.textContent = nome.toUpperCase();
      b.addEventListener('click', () => {
        this.q.aplicarPredefinicao(nome);
        this._sincronizar();
        this._remedir();
      });
      c.predef.appendChild(b);
    }

    // --- Nuvens ----------------------------------------------------------
    // "Desligadas" é o índice -1 e vem primeiro: é a opção que mais devolve
    // desempenho, e quem abre este menu numa máquina fraca deve encontrá-la
    // sem procurar.
    const opcoesNuvem = [['desligadas', -1], ...this.niveisDeNuvem.map((n, i) => [n, i])];
    for (const [rotulo, valor] of opcoesNuvem) {
      const b = document.createElement('button');
      b.dataset.nuvens = String(valor);
      b.textContent = rotulo.toUpperCase();
      b.addEventListener('click', () => {
        this.q.definir('nuvens', valor);
        // Escolher um nível à mão desliga o automático: um controlador que
        // sobrescrevesse a escolha três segundos depois seria um controle
        // quebrado.
        this.q.definir('nuvensAuto', false);
        this._sincronizar();
        this._remedir();
      });
      c.nuvens.appendChild(b);
    }

    // --- Deslizantes -----------------------------------------------------
    // `change` e não `input`: arrastar dispara dezenas de eventos, e cada um
    // redimensiona render targets. Reagir a todos engasgaria justamente ao
    // mexer no controle que existe para tirar o engasgo.
    c.escala.addEventListener('input', () => {
      c.escalaValor.textContent = `${c.escala.value}%`;
    });
    c.escala.addEventListener('change', () => {
      this.q.definir('escalaResolucao', Number(c.escala.value) / 100);
      this._sincronizar();
      this._remedir();
    });

    c.ratio.addEventListener('input', () => {
      c.ratioValor.textContent = (Number(c.ratio.value) / 10).toFixed(1) + '×';
    });
    c.ratio.addEventListener('change', () => {
      this.q.definir('tetoPixelRatio', Number(c.ratio.value) / 10);
      this._sincronizar();
      this._remedir();
    });

    // --- Interruptores ---------------------------------------------------
    const ligar = (campo, chave) => {
      campo.addEventListener('change', () => {
        this.q.definir(chave, campo.checked);
        this._sincronizar();
        this._remedir();
      });
    };
    ligar(c.sombras, 'sombras');
    ligar(c.pos, 'pos');
    ligar(c.detalhe, 'detalheTerreno');

    c.voltar.addEventListener('click', () => this.fechar());
  }

  /** Espelha o estado das preferências nos controles. */
  _sincronizar() {
    const q = this.q;
    const c = this.campos;

    for (const b of c.predef.children) {
      b.classList.toggle('sel', b.dataset.predef === q.predefinicao);
    }
    for (const b of c.nuvens.children) {
      b.classList.toggle('sel', Number(b.dataset.nuvens) === q.nuvens);
    }

    c.escala.value = String(Math.round(q.escalaResolucao * 100));
    c.escalaValor.textContent = `${Math.round(q.escalaResolucao * 100)}%`;
    c.ratio.value = String(Math.round(q.tetoPixelRatio * 10));
    c.ratioValor.textContent = q.tetoPixelRatio.toFixed(1) + '×';

    c.sombras.checked = !!q.sombras;
    c.pos.checked = !!q.pos;
    c.detalhe.checked = !!q.detalheTerreno;
  }

  async _remedir() {
    if (!this.medir || !this.aberto) return;
    this.campos.medida.textContent = 'medindo…';
    const ms = await this.medir();
    if (!this.aberto) return;
    this.campos.medida.textContent =
      ms == null ? 'custo de GPU indisponível neste navegador' : `custo de GPU: ${ms.toFixed(2)} ms por quadro`;
  }

  abrir() {
    this.aberto = true;
    this.raiz.classList.remove('hidden');
    this._sincronizar();
    // O cursor precisa sair do travamento, senão não há como clicar em nada.
    document.exitPointerLock?.();
    this._remedir();
  }

  fechar() {
    this.aberto = false;
    this.raiz.classList.add('hidden');
    this._aoFechar?.();
  }

  alternar() {
    if (this.aberto) this.fechar();
    else this.abrir();
  }
}
