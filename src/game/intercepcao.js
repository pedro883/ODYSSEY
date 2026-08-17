/**
 * Onde mirar para acertar algo que se move.
 *
 * ===========================================================================
 * POR QUE ISTO É UM MÓDULO, E NÃO UM MÉTODO DE CADA ARMA
 * ===========================================================================
 * A conta nasceu dentro de `CanhoesDaNave` porque os canhões da nave foram a
 * primeira arma com tempo de voo. Quando as torres da base entraram, elas
 * precisaram da MESMA conta — e copiá-la seria repetir o erro que o cabeçalho de
 * `Vitals.js` descreve: duas cópias de uma regra de combate divergem na primeira
 * correção, e o jogador passa a ver a nave e a torre errarem de formas
 * diferentes sem motivo que ele possa entender.
 *
 * Aqui a função é pura e a velocidade do projétil entra por parâmetro, que é a
 * única coisa que de fato difere entre uma arma e outra.
 *
 * ===========================================================================
 * A CONTA
 * ===========================================================================
 * Dado o alvo em `P` movendo-se a `V`, a arma em `S` e o projétil a `s`, quer-se
 * o instante `t` em que a bala alcança o alvo:
 *
 *     |P + V·t − S| = s·t
 *
 * Elevando ao quadrado, com `D = P − S`:
 *
 *     (V·V − s²)·t² + 2(V·D)·t + D·D = 0
 *
 * Uma quadrática comum, com três detalhes que decidem se ela serve na prática:
 *
 *   - QUANDO `a ≈ 0` (o alvo foge exatamente à velocidade da bala) ela degenera
 *     em linear. Tratar isso como caso especial evita divisão por zero
 *     justamente na perseguição mais tensa do jogo.
 *   - DAS DUAS RAÍZES interessa a MENOR positiva: é o primeiro encontro. A
 *     maior corresponde à bala alcançando o alvo depois de ele passar por ela,
 *     o que é matemática válida e mira absurda.
 *   - SEM RAIZ POSITIVA não há interceptação possível — o alvo é rápido demais
 *     ou está se afastando rápido demais. Aí quem chamou precisa dizer isso, e
 *     não apontar para um lugar qualquer.
 */

import * as THREE from 'three';

const _D = new THREE.Vector3();

/**
 * Instante do encontro entre projétil e alvo.
 *
 * @param {THREE.Vector3} origem posição da arma
 * @param {THREE.Vector3} alvo posição atual do alvo
 * @param {THREE.Vector3} velocidadeAlvo velocidade do alvo, em unidades/segundo
 * @param {number} velocidadeProjetil módulo da velocidade do tiro
 * @returns {number|null} segundos até o encontro, ou null se não houver
 */
export function tempoDeIntercepcao(origem, alvo, velocidadeAlvo, velocidadeProjetil) {
  _D.copy(alvo).sub(origem);

  const a = velocidadeAlvo.lengthSq() - velocidadeProjetil * velocidadeProjetil;
  const b = 2 * velocidadeAlvo.dot(_D);
  const c = _D.lengthSq();

  // Alvo à mesma velocidade da bala: a quadrática vira linear.
  if (Math.abs(a) < 1e-6) {
    if (Math.abs(b) < 1e-9) return null;
    const t = -c / b;
    return t > 0 ? t : null;
  }

  const disc = b * b - 4 * a * c;
  if (disc < 0) return null; // interceptação impossível

  const raiz = Math.sqrt(disc);
  const t1 = (-b - raiz) / (2 * a);
  const t2 = (-b + raiz) / (2 * a);

  // A MENOR positiva: o primeiro encontro. Sem alocar array — esta função roda
  // por arma, por alvo candidato, a 60 Hz.
  const positivo1 = t1 > 0;
  const positivo2 = t2 > 0;
  if (positivo1 && positivo2) return Math.min(t1, t2);
  if (positivo1) return t1;
  if (positivo2) return t2;
  return null;
}

/**
 * Ponto de mira: onde o alvo estará no instante do encontro.
 *
 * @param {THREE.Vector3} saida preenchido com o ponto
 * @returns {boolean} houve solução?
 */
export function pontoDeIntercepcao(saida, origem, alvo, velocidadeAlvo, velocidadeProjetil) {
  const t = tempoDeIntercepcao(origem, alvo, velocidadeAlvo, velocidadeProjetil);
  if (t === null) return false;
  saida.copy(alvo).addScaledVector(velocidadeAlvo, t);
  return true;
}
