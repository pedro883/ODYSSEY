/**
 * Equipamento do jogador e a barra de troca.
 *
 * ===========================================================================
 * POR QUE UM MODO E NÃO TRÊS BOTÕES
 * ===========================================================================
 * Varrer, minerar, construir e cavar são quatro ações que competem pela MESMA
 * mira e pelo MESMO botão do mouse. A alternativa a modos seria espalhá-las por
 * teclas diferentes, e o resultado é o que o jogo tinha antes: botão esquerdo
 * mina, `V` varre, `B` entra num quarto estado que sequestra o clique, e nada
 * na tela diz o que o clique faz agora.
 *
 * Com equipamento, a pergunta "o que acontece se eu clicar?" tem uma resposta
 * só, visível em dois lugares ao mesmo tempo: o item aceso na barra e o objeto
 * na mão do personagem. É o motivo de a barra e o modelo em primeira pessoa
 * terem sido feitos juntos — um sem o outro resolve metade do problema.
 */

export const FERRAMENTAS = [
  {
    id: 'multiferramenta',
    nome: 'Multiferramenta',
    /** O que o botão esquerdo faz, para o prompt da interface. */
    acao: 'extrair',
    secundaria: 'varredura',
    modelo: 'ferramenta/blaster-d.glb',
    /** Cor do feixe e do realce na barra. */
    cor: 0xffb347,
  },
  {
    id: 'construtor',
    nome: 'Construtor',
    acao: 'construir',
    secundaria: 'demolir',
    modelo: 'ferramenta/blaster-i.glb',
    cor: 0x58e8ff,
  },
  {
    id: 'terraformador',
    nome: 'Terraformador',
    acao: 'cavar',
    secundaria: 'elevar',
    modelo: 'ferramenta/blaster-p.glb',
    cor: 0x8ef0a8,
  },
  {
    id: 'blaster',
    nome: 'Blaster de Plasma',
    acao: 'disparar',
    secundaria: 'granada',
    // Reaproveita o modelo da multiferramenta: os três `blaster-*.glb` do pacote
    // já estão em uso pelas outras ferramentas, e o `-d` é o que mais parece uma
    // arma. Trocar por arte própria é uma questão de asset, não de código.
    modelo: 'ferramenta/blaster-d.glb',
    cor: 0x9ef0ff,
  },
];

export const FERRAMENTA_POR_ID = new Map(FERRAMENTAS.map((f) => [f.id, f]));

/** Caminhos que o boot precisa pré-carregar. */
export function caminhosDeFerramentas() {
  return FERRAMENTAS.map((f) => f.modelo);
}
