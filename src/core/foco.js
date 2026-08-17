/**
 * Quem está com o teclado agora: o jogo ou um campo de texto?
 *
 * ===========================================================================
 * O BUG QUE ISTO EXISTE PARA IMPEDIR
 * ===========================================================================
 * Os controles da nave e do jogador escutam `keydown` na JANELA, porque o jogo
 * precisa responder a teclas sem depender de onde está o foco — o canvas não é
 * focável e exigir um clique nele antes de andar seria pior.
 *
 * O efeito colateral é que esses mesmos ouvintes recebem as teclas digitadas
 * dentro de um `<input>`. E `ShipController` chamava `preventDefault()` em
 * `KeyW`, `KeyA`, `KeyS`, `KeyD` e `Space` sem olhar para o foco: o resultado
 * era que essas cinco teclas simplesmente NÃO ENTRAVAM no campo do nome do
 * piloto nem no da senha. Medido: digitar "Wasda Cx" deixava "Cx" na tela.
 *
 * O sintoma é traiçoeiro porque não é o campo inteiro que falha — a maioria das
 * letras funciona. A pessoa conclui que errou a digitação, tenta de novo, e
 * chega à conclusão de que o jogo "não aceita algumas letras". Uma senha então
 * fica restrita a um alfabeto arbitrário sem que nada explique por quê.
 *
 * Pior ainda, era silencioso nos dois sentidos: `KeyC`, `KeyG` e `KeyX` não
 * eram bloqueadas, mas ALTERNAVAM visão de cabine, piloto automático e pulso
 * enquanto a pessoa escrevia o nome. Quem se chamasse "Max" começava a partida
 * com o pulso invertido e nenhuma pista do motivo. As teclas ainda ficavam
 * presas no conjunto de input, então a nave saía andando ao iniciar.
 *
 * ===========================================================================
 * POR QUE UM MÓDULO E NÃO UM `if` EM CADA CONTROLE
 * ===========================================================================
 * A regra precisa ser a MESMA nos três ouvintes globais (nave, jogador e os
 * atalhos de `main.js`). Três cópias de "isto é um campo de texto?" divergem na
 * primeira vez que alguém acrescentar um `<textarea>` ou um campo editável — e
 * a divergência reaparece como este mesmo bug, num campo só.
 */

/**
 * O alvo do evento é algo em que se digita?
 *
 * Usa o ALVO do evento e não `document.activeElement` porque são a mesma coisa
 * no caso normal e o alvo é mais honesto: ele diz de onde o evento realmente
 * partiu, inclusive quando o foco muda no meio do tratamento.
 *
 * `isContentEditable` cobre os editores que não são `<input>`; `SELECT` entra
 * porque as setas e as letras navegam pelas opções dele.
 *
 * @param {EventTarget|null} alvo
 * @returns {boolean}
 */
export function digitando(alvo) {
  const el = /** @type {HTMLElement|null} */ (alvo);
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;

  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;

  // Um `<input type="checkbox">` ou `range` NÃO é digitação: ali o espaço e as
  // setas são do controle, e o jogo não deve reivindicá-las de volta — mas
  // também não há texto para atrapalhar. Tratar tudo como campo de texto seria
  // igualmente correto aqui; a distinção existe para o dia em que um controle
  // desses aparecer no meio do jogo e o teclado precisar continuar respondendo.
  const tipo = (/** @type {HTMLInputElement} */ (el).type || 'text').toLowerCase();
  return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file'].includes(tipo);
}
