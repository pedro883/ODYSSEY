/**
 * Servidor de multijogador — relay autoritativo do MUNDO, não da física.
 *
 * ---------------------------------------------------------------------------
 * O QUE PRECISA SER SINCRONIZADO, E O QUE NÃO
 * ---------------------------------------------------------------------------
 * O universo inteiro deste jogo é função de um inteiro (o seed). Terreno,
 * biomas, posição de cada arbusto, espécie de cada bicho: nada disso precisa
 * trafegar, porque os dois clientes calculam exatamente a mesma coisa. É a
 * maior vantagem de um mundo procedural determinístico, e ela define o
 * protocolo inteiro.
 *
 * Sobra o que NÃO deriva do seed:
 *
 *   1. **Onde cada jogador está** — posição, orientação, a pé ou de nave, e a
 *      transformação da nave dele (que fica parada onde foi deixada).
 *   2. **O que já foi colhido** — a única mutação persistente do mundo. Um
 *      arbusto colhido pelo outro jogador precisa sumir da sua tela, e
 *      continuar sumido para quem entrar depois.
 *
 * Por isso o servidor guarda só duas coisas: uma tabela de jogadores e um
 * conjunto de props colhidos. Estado de terreno, de fauna e de inventário
 * nunca chegam aqui.
 *
 * ---------------------------------------------------------------------------
 * O SEED É DO SERVIDOR
 * ---------------------------------------------------------------------------
 * Dois clientes com seeds diferentes estariam em universos diferentes, e a
 * sincronia de posição colocaria o outro jogador dentro de uma montanha que
 * para ele não existe. O servidor fixa o seed e o cliente se realinha (ver
 * `src/net/Multiplayer.js`). É a razão de o seed vir no `welcome`.
 *
 * ---------------------------------------------------------------------------
 * O QUE ESTE SERVIDOR NÃO É
 * ---------------------------------------------------------------------------
 * Não é autoritativo sobre movimento: ele confia na posição que o cliente
 * envia. Para uma PoC cooperativa isso é o suficiente e mantém o código legível;
 * num jogo competitivo seria convite a trapaça, e a física teria de rodar aqui.
 */

import { WebSocketServer } from 'ws';
import { Banco } from './db.js';

const PORTA = Number(process.env.PORT ?? 5200);

/** Seed do universo desta sala. `--seed=N` fixa; senão sorteia uma vez. */
const argSeed = process.argv.find((a) => a.startsWith('--seed='));
const SEED = argSeed ? Number(argSeed.split('=')[1]) >>> 0 : (Math.random() * 0xffffffff) >>> 0;

const banco = new Banco();
await banco.conectar();

const servidor = new WebSocketServer({ port: PORTA });

/** @type {Map<number, {id:number, nome:string, socket:object, estado:object}>} */
const jogadores = new Map();

/**
 * Props já colhidos, por planeta.
 *
 * Chave: `planetaId:chaveDoChunk`, valor: Set de índices. É exatamente o
 * formato que o `PropScatter.harvested` usa do lado do cliente, então aplicar
 * o que chega é uma linha lá.
 * @type {Map<string, Set<number>>}
 */
const colhidos = new Map();

/**
 * Peças construídas, por slot.
 *
 * Chave: `base:cx,cy,cz,face` — a mesma que o cliente usa, para que aplicar o
 * que chega seja um `set` e um `delete`.
 * @type {Map<string, object>}
 */
const construcoes = new Map();

/**
 * Referencial de cada base, à parte das peças.
 *
 * Existe porque o `frame` só viaja no PRIMEIRO evento de uma base — depois
 * disso ele é redundante. Guardá-lo separado é o que permite demolir essa
 * primeira peça sem que a base fique órfã: quem entrar depois recebe todos os
 * eventos já com o referencial injetado de volta.
 * @type {Map<string, object>}
 */
const frames = new Map();

/** Chave de slot de uma peça. */
function chaveDaPeca(evento) {
  return `${evento.base}:${evento.cel[0]},${evento.cel[1]},${evento.cel[2]},${evento.face}`;
}

/**
 * Escavações de terreno, por planeta.
 *
 * `planetaId -> (idDaEdicao -> edicao)`. Um `Map` por id, e não uma lista,
 * porque o cliente REENVIA a mesma edição enquanto cava, com a profundidade
 * crescendo — o último valor vence e o buraco não vira uma pilha de cem
 * crateras sobrepostas.
 *
 * O platô sob uma base NÃO entra aqui: ele é função pura das peças dela e cada
 * cliente o recalcula sozinho (ver `BuildSystem._aplainar`).
 * @type {Map<number, Map<string, object>>}
 */
const terreno = new Map();

/**
 * Teto de escavações guardadas por planeta.
 *
 * ---------------------------------------------------------------------------
 * POR QUE UM ORÇAMENTO, E POR QUE DESCARTE PELO MAIS ANTIGO
 * ---------------------------------------------------------------------------
 * Deformação de terreno é o único dado deste jogo que cresce sem limite
 * natural: props colhidos acabam quando o planeta acaba, peças de base param
 * quando o jogador para de construir, mas cavar é uma ação que uma pessoa pode
 * repetir para sempre. Sem teto, um universo com meses de uso carrega uma lista
 * que todo cliente precisa baixar ao entrar e todo vértice de terreno precisa
 * consultar.
 *
 * O jogo do gênero resolve isso do mesmo jeito: há um limite de voxels
 * modificados e, ao estourá-lo, as alterações mais antigas são abandonadas e
 * aquele pedaço volta à forma procedural. É perda de dado deliberada — e é a
 * escolha certa, porque o alternativo é o mundo ficar lento para todo mundo por
 * causa de uma vala que alguém cavou e esqueceu.
 *
 * O platô de uma base NÃO passa por aqui (é derivado das peças), então
 * construções nunca são apagadas por este mecanismo.
 */
const MAX_EDICOES_POR_PLANETA = 400;

function terrenoDoPlaneta(planetaId) {
  let mapa = terreno.get(planetaId);
  if (!mapa) terreno.set(planetaId, (mapa = new Map()));
  return mapa;
}

/**
 * Aplica o orçamento, devolvendo os ids abandonados.
 *
 * `Map` preserva ordem de inserção, então a primeira chave é sempre a mais
 * antiga — o mesmo truque do cache LRU de chunks no cliente.
 */
function podarTerreno(planetaId) {
  const mapa = terrenoDoPlaneta(planetaId);
  const removidos = [];
  while (mapa.size > MAX_EDICOES_POR_PLANETA) {
    const maisAntiga = mapa.keys().next().value;
    mapa.delete(maisAntiga);
    removidos.push(maisAntiga);
  }
  return removidos;
}

/** Serializa as escavações no formato que o `welcome` carrega. */
function terrenoParaLista() {
  const saida = [];
  for (const [planetaId, mapa] of terreno) {
    if (mapa.size > 0) saida.push([planetaId, [...mapa.values()]]);
  }
  return saida;
}

// O que já foi colhido neste universo vem do banco ANTES de aceitar conexões.
// Carregar sob demanda deixaria o primeiro jogador ver, por alguns segundos,
// arbustos que outra pessoa colheu semanas atrás.
if (banco.disponivel) {
  const guardado = await banco.carregarColhidos(SEED);
  for (const [chave, indices] of guardado) colhidos.set(chave, indices);
  const total = [...colhidos.values()].reduce((soma, c) => soma + c.size, 0);
  console.log(`[db] ${total} props colhidos restaurados do universo ${SEED}`);

  for (const evento of await banco.carregarConstrucoes(SEED)) {
    construcoes.set(chaveDaPeca(evento), evento);
    if (evento.frame) frames.set(evento.base, evento.frame);
  }
  console.log(`[db] ${construcoes.size} peças de base restauradas em ${frames.size} bases`);

  let totalTerreno = 0;
  for (const edicao of await banco.carregarTerreno(SEED)) {
    terrenoDoPlaneta(edicao.planeta).set(edicao.id, edicao.dados);
    totalTerreno++;
  }
  console.log(`[db] ${totalTerreno} escavações de terreno restauradas`);
}

/** Conta autenticada por conexão, quando houver banco. @type {Map<number,{contaId:number,login:string}>} */
const contas = new Map();

let proximoId = 1;

function enviar(socket, mensagem) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(mensagem));
}

function transmitir(mensagem, exceto) {
  const texto = JSON.stringify(mensagem);
  for (const jogador of jogadores.values()) {
    if (jogador.id === exceto) continue;
    if (jogador.socket.readyState === jogador.socket.OPEN) jogador.socket.send(texto);
  }
}

/** Serializa o mapa de colhidos para caber num JSON. */
function colhidosParaLista() {
  const saida = [];
  for (const [chave, indices] of colhidos) saida.push([chave, [...indices]]);
  return saida;
}

servidor.on('connection', (socket) => {
  const id = proximoId++;

  // O seed vai ANTES de qualquer coisa, sem esperar o `join`.
  //
  // O cliente sorteia um seed próprio ao abrir e só descobre o da sala ao
  // entrar. Se essa descoberta acontecesse no `join` — que só sai quando a
  // pessoa confirma o nome —, ela clicaria em INICIAR VOO e a página
  // recarregaria de volta para o menu, com outro universo. Mandando aqui, o
  // realinhamento acontece durante a geração do terreno e ninguém percebe.
  enviar(socket, { type: 'hello', seed: SEED });

  socket.on('message', (dados) => {
    let mensagem;
    try {
      mensagem = JSON.parse(dados);
    } catch {
      return; // pacote corrompido: ignora em vez de derrubar a sala
    }

    switch (mensagem.type) {
      case 'login': {
        // Autenticação separada do `join` de propósito: quem não tem banco
        // continua entrando direto pelo `join`, e o fluxo de conta é um passo
        // OPCIONAL por cima — não uma barreira nova para todo mundo.
        const login = String(mensagem.login ?? '').trim().slice(0, 24);
        const senha = String(mensagem.senha ?? '');

        if (!banco.disponivel) {
          enviar(socket, { type: 'login', ok: false, erro: 'servidor sem banco de dados' });
          return;
        }
        if (login.length < 3 || senha.length < 4) {
          enviar(socket, { type: 'login', ok: false, erro: 'login ou senha curtos demais' });
          return;
        }

        banco
          .autenticar(login, senha)
          .then(async (resultado) => {
            if (!resultado.ok) {
              enviar(socket, { type: 'login', ok: false, erro: resultado.erro });
              return;
            }
            contas.set(id, { contaId: resultado.id, login });
            const progresso = await banco.carregarProgresso(resultado.id, SEED);
            enviar(socket, { type: 'login', ok: true, login, novo: resultado.novo, progresso });
            console.log(`[mp] ${login} autenticou (${resultado.novo ? 'conta nova' : 'conta existente'})`);
          })
          .catch((erro) => {
            console.error('[db] falha ao autenticar:', erro.message);
            enviar(socket, { type: 'login', ok: false, erro: 'falha no servidor' });
          });
        break;
      }

      case 'progresso': {
        // Chega periodicamente e ao sair. Sem conta, não há onde guardar.
        const conta = contas.get(id);
        if (!conta || !banco.disponivel) return;
        banco
          .salvarProgresso(conta.contaId, SEED, mensagem.progresso ?? {})
          .catch((erro) => console.error('[db] falha ao salvar progresso:', erro.message));
        break;
      }

      case 'join': {
        const nome = String(mensagem.nome ?? `Piloto ${id}`).slice(0, 24);
        jogadores.set(id, { id, nome, socket, estado: null });

        enviar(socket, {
          type: 'welcome',
          id,
          seed: SEED,
          colhidos: colhidosParaLista(),
          // Com o `frame` de volta em TODOS os eventos: o cliente que entra
          // agora nunca viu a criação da base e não teria como situá-la.
          construcoes: [...construcoes.values()].map((e) => ({
            ...e,
            frame: frames.get(e.base) ?? null,
          })),
          terreno: terrenoParaLista(),
          // TODOS os outros, inclusive quem ainda não mandou posição.
          //
          // O filtro `&& j.estado` que existia aqui parecia inofensivo — para
          // que anunciar alguém sem posição conhecida? — e produzia o pior bug
          // possível numa sala: dois jogadores que entram e ficam parados nunca
          // ficam sabendo um do outro. O `entrou` do primeiro foi transmitido
          // antes de o segundo existir, e o `welcome` do segundo o omitia por
          // falta de estado. Cada um via uma sala vazia.
          //
          // O cliente lida com `estado: null` sozinho: o avatar nasce invisível
          // e aparece no primeiro pacote de posição.
          jogadores: [...jogadores.values()]
            .filter((j) => j.id !== id)
            .map((j) => ({ id: j.id, nome: j.nome, estado: j.estado })),
        });

        transmitir({ type: 'entrou', id, nome }, id);
        console.log(`[mp] ${nome} (#${id}) entrou — ${jogadores.size} na sala`);
        break;
      }

      case 'state': {
        const jogador = jogadores.get(id);
        if (!jogador) return;
        jogador.estado = mensagem.estado;
        // Repassa cru: o pacote já vem no formato que o cliente consome, e
        // reempacotar por jogador multiplicaria o custo por conexão.
        transmitir({ type: 'state', id, estado: mensagem.estado }, id);
        break;
      }

      case 'construcao': {
        const evento = mensagem.evento;
        // Validação mínima antes de gravar: um pacote malformado aqui vira uma
        // linha permanente no banco que todo cliente futuro tenta interpretar.
        if (
          !evento ||
          !Array.isArray(evento.cel) ||
          evento.cel.length !== 3 ||
          !evento.cel.every((v) => Number.isInteger(v)) ||
          !Number.isInteger(evento.face) ||
          !Number.isInteger(evento.planeta)
        ) {
          return;
        }

        const chave = chaveDaPeca(evento);

        if (evento.tipo === 'demolir') {
          if (!construcoes.delete(chave)) return;
          banco
            .removerConstrucao(SEED, evento.base, evento.cel, evento.face)
            .catch((erro) => console.error('[db] falha ao demolir:', erro.message));
        } else {
          // Slot ocupado: dois jogadores construíram no mesmo lugar no mesmo
          // instante. O primeiro pacote a chegar vence e o segundo é descartado
          // — sem isso, os dois clientes ficariam com peças diferentes ali.
          if (construcoes.has(chave)) return;
          if (typeof evento.peca !== 'string' || evento.peca.length > 24) return;

          if (evento.frame) frames.set(evento.base, evento.frame);
          construcoes.set(chave, evento);
          banco
            .gravarConstrucao(SEED, evento, frames.get(evento.base))
            .catch((erro) => console.error('[db] falha ao gravar construção:', erro.message));
        }

        transmitir({ type: 'construcao', evento }, id);
        break;
      }

      case 'terreno': {
        const e = mensagem.edicao;
        // Uma edição malformada aqui vira uma linha permanente que todo cliente
        // futuro aplica ao terreno — e um `r` gigante achataria um continente.
        if (
          !e ||
          typeof e.id !== 'string' || e.id.length === 0 || e.id.length > 16 ||
          !Number.isFinite(e.x) || !Number.isFinite(e.y) || !Number.isFinite(e.z) ||
          !Number.isFinite(e.r) || !Number.isFinite(e.f) ||
          !Number.isInteger(mensagem.planeta) ||
          e.r <= 0 || e.r > 64 || Math.abs(e.f) > 64
        ) {
          return;
        }

        const edicao = { id: e.id, x: e.x, y: e.y, z: e.z, r: e.r, f: e.f, t: e.t === 1 ? 1 : 0 };
        terrenoDoPlaneta(mensagem.planeta).set(edicao.id, edicao);
        banco
          .gravarTerreno(SEED, mensagem.planeta, edicao)
          .catch((erro) => console.error('[db] falha ao gravar terreno:', erro.message));
        transmitir({ type: 'terreno', planeta: mensagem.planeta, edicao }, id);

        // Orçamento: as escavações mais antigas do planeta são abandonadas e o
        // relevo volta ao procedural ali. Avisa TODO MUNDO, inclusive quem
        // acabou de cavar — do contrário cada cliente teria uma ideia diferente
        // de quais buracos ainda existem.
        const expiradas = podarTerreno(mensagem.planeta);
        if (expiradas.length > 0) {
          banco
            .removerTerreno(SEED, mensagem.planeta, expiradas)
            .catch((erro) => console.error('[db] falha ao podar terreno:', erro.message));
          transmitir({ type: 'terreno-expirado', planeta: mensagem.planeta, ids: expiradas });
          enviar(socket, { type: 'terreno-expirado', planeta: mensagem.planeta, ids: expiradas });
        }
        break;
      }

      case 'harvest': {
        const chave = `${mensagem.planeta}:${mensagem.chunk}`;
        let indices = colhidos.get(chave);
        if (!indices) colhidos.set(chave, (indices = new Set()));
        // Já colhido: não retransmite. Sem esta guarda, dois jogadores mirando
        // o mesmo arbusto geram um eco infinito entre clientes.
        if (indices.has(mensagem.indice)) return;
        indices.add(mensagem.indice);
        banco
          .registrarColheita(SEED, mensagem.planeta, mensagem.chunk, mensagem.indice)
          .catch((erro) => console.error('[db] falha ao gravar colheita:', erro.message));
        transmitir({ type: 'harvest', planeta: mensagem.planeta, chunk: mensagem.chunk, indice: mensagem.indice }, id);
        break;
      }
    }
  });

  socket.on('close', () => {
    const jogador = jogadores.get(id);
    if (!jogador) return;
    jogadores.delete(id);
    contas.delete(id);
    transmitir({ type: 'saiu', id });
    console.log(`[mp] ${jogador.nome} (#${id}) saiu — ${jogadores.size} na sala`);
  });
});

console.log(`[mp] sala aberta em ws://localhost:${PORTA} · seed ${SEED}`);
