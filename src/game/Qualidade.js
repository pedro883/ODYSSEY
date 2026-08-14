/**
 * Preferências gráficas: um lugar só, persistido, aplicado a quem interessa.
 *
 * ===========================================================================
 * O QUE A MEDIÇÃO MOSTROU
 * ===========================================================================
 * Com a câmera parada na superfície, a 1280×720, o quadro custava 5,73 ms de
 * GPU. Escondendo APENAS as cascas de nuvem, caía para 0,65 ms — as nuvens eram
 * quase 90% do custo. E havia CINCO cascas sendo desenhadas, uma por planeta do
 * sistema, incluindo mundos a oitenta mil unidades.
 *
 * Isso explica o relato de 10 fps em máquinas fracas justamente NO PLANETA: ray
 * marching é custo de fragmento puro, escala com a área de tela coberta, e ao
 * nível do solo a casca cobre o céu inteiro. É o pior caso possível para uma
 * GPU integrada, que é exatamente onde ela é mais fraca.
 *
 * ===========================================================================
 * AS ALAVANCAS, DA MAIS FORTE PARA A MAIS FRACA
 * ===========================================================================
 *   1. ESCALA DE RESOLUÇÃO. Como quase todo o custo é de fragmento, renderizar
 *      a 70% da largura e altura corta metade do trabalho de TODOS os passes de
 *      uma vez — nuvens, atmosfera, perspectiva aérea e pós-processamento. É a
 *      única alavanca que ataca o problema inteiro em vez de uma peça dele.
 *   2. NUVENS. Perfil mais barato e corte por distância mais agressivo.
 *   3. PIXELS DO DISPOSITIVO. Num portátil HiDPI fraco, `devicePixelRatio` 2
 *      quadruplica o número de fragmentos antes de qualquer outra conta.
 *   4. SOMBRAS e PÓS-PROCESSAMENTO, que são caros em termos absolutos mas
 *      pequenos perto das nuvens.
 *
 * ===========================================================================
 * POR QUE O PADRÃO É "EQUILIBRADO" E NÃO "ALTO"
 * ===========================================================================
 * O padrão anterior era o teto de tudo, e o controlador automático só descia
 * DEPOIS de medir quadros ruins — ou seja, todo jogador de máquina fraca via o
 * jogo engasgar antes de melhorar. Começar no meio inverte isso: quem tem
 * máquina boa sobe (o automático das nuvens continua funcionando) e quem não
 * tem nunca chega a ver o engasgo.
 */

const CHAVE = 'nms.qualidade';

/**
 * Predefinições. Os campos são deliberadamente os mesmos em todas para que a
 * interface possa mostrar o que cada uma muda sem nenhum caso especial.
 */
export const PREDEFINICOES = {
  desempenho: {
    rotulo: 'Desempenho',
    escalaResolucao: 0.6,
    tetoPixelRatio: 1,
    nuvens: 0, // índice em TIERS de Clouds.js; -1 desliga
    nuvensAuto: true,
    sombras: false,
    pos: false,
    detalheTerreno: false,
  },
  equilibrado: {
    rotulo: 'Equilibrado',
    escalaResolucao: 0.85,
    tetoPixelRatio: 1.5,
    nuvens: 1,
    nuvensAuto: true,
    sombras: true,
    pos: true,
    detalheTerreno: true,
  },
  alto: {
    rotulo: 'Alto',
    escalaResolucao: 1,
    tetoPixelRatio: 2,
    nuvens: 3,
    nuvensAuto: true,
    sombras: true,
    pos: true,
    detalheTerreno: true,
  },
};

/** Usado quando não há nada gravado. Ver a nota longa acima. */
export const PADRAO = 'equilibrado';

function carregar() {
  try {
    const cru = localStorage.getItem(CHAVE);
    if (!cru) return { ...PREDEFINICOES[PADRAO], predefinicao: PADRAO };
    const salvo = JSON.parse(cru);
    // Mescla sobre a predefinição: um campo novo acrescentado numa versão
    // futura não fica `undefined` para quem já tem preferências gravadas.
    const base = PREDEFINICOES[salvo.predefinicao] ?? PREDEFINICOES[PADRAO];
    return { ...base, ...salvo };
  } catch {
    // localStorage pode lançar em modo privado ou com armazenamento bloqueado,
    // e uma preferência gráfica jamais pode impedir o jogo de abrir.
    return { ...PREDEFINICOES[PADRAO], predefinicao: PADRAO };
  }
}

export class Qualidade {
  constructor() {
    Object.assign(this, carregar());
    /** @type {Array<() => void>} */
    this._ouvintes = [];

    // A URL vence o que está gravado, e não o contrário: os parâmetros de
    // depuração existem justamente para reproduzir um caso sem ter de mexer nas
    // preferências do usuário.
    const params = new URLSearchParams(location.search);
    if (params.get('post') === 'off') this.pos = false;
    if (params.get('sombras') === 'off') this.sombras = false;
    if (params.has('escala')) {
      const v = Number(params.get('escala'));
      if (v > 0.2 && v <= 1) this.escalaResolucao = v;
    }
  }

  /** Notificado quando qualquer campo muda. Quem aplica se inscreve aqui. */
  aoMudar(fn) {
    this._ouvintes.push(fn);
    return this;
  }

  aplicarPredefinicao(nome) {
    const p = PREDEFINICOES[nome];
    if (!p) return;
    Object.assign(this, p);
    this.predefinicao = nome;
    this._mudou();
  }

  definir(campo, valor) {
    if (this[campo] === valor) return;
    this[campo] = valor;
    // Mexer num controle individual desfaz a predefinição: dizer "Alto" com
    // sombras desligadas seria mentira, e o jogador que voltasse ao menu não
    // saberia mais o que está ligado.
    this.predefinicao = 'personalizado';
    this._mudou();
  }

  _mudou() {
    try {
      localStorage.setItem(CHAVE, JSON.stringify(this._paraGravar()));
    } catch {
      /* ver `carregar`: preferência nunca derruba o jogo */
    }
    for (const fn of this._ouvintes) fn(this);
  }

  _paraGravar() {
    return {
      predefinicao: this.predefinicao,
      escalaResolucao: this.escalaResolucao,
      tetoPixelRatio: this.tetoPixelRatio,
      nuvens: this.nuvens,
      nuvensAuto: this.nuvensAuto,
      sombras: this.sombras,
      pos: this.pos,
      detalheTerreno: this.detalheTerreno,
    };
  }
}
