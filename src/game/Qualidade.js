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
    atmosfera: 'baixo',
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
    atmosfera: 'medio',
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
    atmosfera: 'alto',
  },
};

/** Usado quando não há nada gravado. Ver a nota longa acima. */
export const PADRAO = 'equilibrado';

/**
 * Faixas de custo para a calibragem automática, em milissegundos de GPU por
 * quadro medidos na tela de carregamento com a predefinição `PADRAO` aplicada.
 *
 * Os números saem de um alvo, não de um chute: 8 ms é meio quadro a 60 Hz, e
 * quem já gasta isso na cena PARADA do menu não tem folga para o jogo em
 * movimento. Abaixo de 3 ms sobra margem para subir.
 */
export const FAIXAS_CALIBRAGEM = { alto: 3, equilibrado: 8 };

function carregar() {
  try {
    const cru = localStorage.getItem(CHAVE);
    if (!cru) return { ...PREDEFINICOES[PADRAO], predefinicao: PADRAO, gravado: false };
    const salvo = JSON.parse(cru);
    // Mescla sobre a predefinição: um campo novo acrescentado numa versão
    // futura não fica `undefined` para quem já tem preferências gravadas.
    const base = PREDEFINICOES[salvo.predefinicao] ?? PREDEFINICOES[PADRAO];
    // `gravado` distingue "o usuário já escolheu" de "é a primeira vez aqui". É
    // o que impede a calibragem automática de atropelar uma escolha deliberada:
    // quem baixou de propósito para ganhar fps não pode ser promovido de volta
    // no próximo boot.
    return { ...base, ...salvo, gravado: true };
  } catch {
    // localStorage pode lançar em modo privado ou com armazenamento bloqueado,
    // e uma preferência gráfica jamais pode impedir o jogo de abrir.
    return { ...PREDEFINICOES[PADRAO], predefinicao: PADRAO, gravado: false };
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

  /**
   * Aplica uma predefinição SEM gravá-la — para a calibragem automática.
   *
   * A diferença com `aplicarPredefinicao` é toda o registro. Gravar marcaria
   * esta máquina como "o usuário escolheu", e a partir daí a calibragem nunca
   * mais rodaria: trocar de placa de vídeo, ou rodar o mesmo perfil num
   * computador diferente, ficaria preso na decisão tomada numa máquina que não
   * é mais esta. Uma escolha do jogador vale para sempre; um palpite do jogo
   * vale para esta sessão e é refeito na próxima.
   */
  calibrar(nome) {
    const p = PREDEFINICOES[nome];
    if (!p) return;
    Object.assign(this, p);
    this.predefinicao = nome;
    for (const fn of this._ouvintes) fn();
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
    // A partir daqui existe escolha registrada, e a calibragem automática do
    // próximo boot precisa respeitá-la.
    this.gravado = true;
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
      atmosfera: this.atmosfera,
    };
  }
}
