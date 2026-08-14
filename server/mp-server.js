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

/**
 * Sistema de ENTRADA da sala. `--seed=N` fixa; senão sorteia uma vez.
 *
 * Deixou de ser "o universo desta sala" e virou apenas o endereço padrão para
 * quem chega sem escolher nenhum — ver o cabeçalho de `canalDe`.
 */
const argSeed = process.argv.find((a) => a.startsWith('--seed='));
const SEED = argSeed ? Number(argSeed.split('=')[1]) >>> 0 : (Math.random() * 0xffffffff) >>> 0;

const banco = new Banco();
await banco.conectar();

const servidor = new WebSocketServer({ port: PORTA });

/**
 * Jogadores conectados. Cada um carrega o SEED do sistema em que está.
 * @type {Map<number, {id:number, nome:string, socket:object, estado:object, seed:number}>}
 */
const jogadores = new Map();

/* ==========================================================================
   CANAIS: um sistema estelar, um mundo compartilhado
   ==========================================================================

   ---------------------------------------------------------------------------
   POR QUE A SALA DEIXOU DE SER UM UNIVERSO SÓ
   ---------------------------------------------------------------------------
   Até aqui o servidor fixava um seed e obrigava todo mundo a ele: quem entrava
   com outro tinha a página recarregada até coincidir. Isso mantinha o relay
   simples e tornava o hiperimpulsor uma mentira — dois jogadores saltavam para
   sistemas diferentes e continuavam se vendo, cada um voando dentro do planeta
   que o outro não tinha.

   Agora cada SISTEMA é um canal. Posição, colheita, construção e escavação só
   circulam entre quem está no mesmo seed; saltar é trocar de canal. Encontrar
   alguém deixa de ser o padrão e passa a ser o que era para ser: coincidência
   de estarem no mesmo lugar da galáxia.

   ---------------------------------------------------------------------------
   O BANCO JÁ ESTAVA PRONTO PARA ISTO
   ---------------------------------------------------------------------------
   `colhido`, `construcao` e `terreno` sempre tiveram `seed` na chave primária —
   o esquema modelava sistemas separados desde o início, e era só o servidor que
   carregava um deles e ignorava o resto. Por isso esta mudança não tem migração
   nenhuma: o que muda é QUANDO cada conjunto é lido.

   Um canal é carregado do banco na primeira vez que alguém entra nele, e não no
   boot: um servidor com cem sistemas visitados não tem por que ler os cem para
   servir o jogador que está em um.
   ========================================================================== */

/** @type {Map<number, object>} seed -> canal */
const canais = new Map();

function canalDe(seed) {
  const chave = seed >>> 0;
  let canal = canais.get(chave);
  if (!canal) {
    canais.set(chave, (canal = {
      seed: chave,
      /**
       * Props colhidos. Chave `planetaId:chaveDoChunk`, valor Set de índices —
       * exatamente o formato que o `PropScatter.harvested` usa no cliente.
       * @type {Map<string, Set<number>>}
       */
      colhidos: new Map(),
      /** Peças por slot (`base:cx,cy,cz,face`). @type {Map<string, object>} */
      construcoes: new Map(),
      /**
       * Referencial de cada base, à parte das peças: o `frame` só viaja no
       * PRIMEIRO evento de uma base, e guardá-lo aqui é o que permite demolir
       * essa peça sem deixar a base órfã para quem entrar depois.
       * @type {Map<string, object>}
       */
      frames: new Map(),
      /**
       * Escavações por planeta. `planetaId -> (id -> edicao)`: o cliente
       * REENVIA a mesma edição enquanto cava, com a profundidade crescendo, e
       * o último valor vence — sem isso um buraco vira uma pilha de crateras.
       * @type {Map<number, Map<string, object>>}
       */
      terreno: new Map(),
      /** Ids dos jogadores presentes. @type {Set<number>} */
      presentes: new Set(),
      /** Promessa da carga do banco, ou `true` quando já terminou. */
      pronto: null,
    }));
  }
  return canal;
}

/**
 * Lê do banco o que este sistema guarda. Idempotente e com uma promessa só:
 * dois jogadores entrando juntos num canal frio não podem disparar duas cargas.
 */
function prepararCanal(canal) {
  if (canal.pronto) return canal.pronto;
  if (!banco.disponivel) return (canal.pronto = Promise.resolve());

  canal.pronto = (async () => {
    const guardado = await banco.carregarColhidos(canal.seed);
    for (const [chave, indices] of guardado) canal.colhidos.set(chave, indices);

    for (const evento of await banco.carregarConstrucoes(canal.seed)) {
      canal.construcoes.set(chaveDaPeca(evento), evento);
      if (evento.frame) canal.frames.set(evento.base, evento.frame);
    }

    let totalTerreno = 0;
    for (const edicao of await banco.carregarTerreno(canal.seed)) {
      terrenoDoPlaneta(canal, edicao.planeta).set(edicao.id, edicao.dados);
      totalTerreno++;
    }

    const props = [...canal.colhidos.values()].reduce((s, c) => s + c.size, 0);
    console.log(
      `[db] sistema ${canal.seed}: ${props} props colhidos, ` +
      `${canal.construcoes.size} peças, ${totalTerreno} escavações`
    );
  })().catch((erro) => console.error('[db] falha ao carregar sistema:', erro.message));

  return canal.pronto;
}

/** Chave de slot de uma peça. */
function chaveDaPeca(evento) {
  return `${evento.base}:${evento.cel[0]},${evento.cel[1]},${evento.cel[2]},${evento.face}`;
}

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

function terrenoDoPlaneta(canal, planetaId) {
  let mapa = canal.terreno.get(planetaId);
  if (!mapa) canal.terreno.set(planetaId, (mapa = new Map()));
  return mapa;
}

/**
 * Aplica o orçamento, devolvendo os ids abandonados.
 *
 * `Map` preserva ordem de inserção, então a primeira chave é sempre a mais
 * antiga — o mesmo truque do cache LRU de chunks no cliente.
 */
function podarTerreno(canal, planetaId) {
  const mapa = terrenoDoPlaneta(canal, planetaId);
  const removidos = [];
  while (mapa.size > MAX_EDICOES_POR_PLANETA) {
    const maisAntiga = mapa.keys().next().value;
    mapa.delete(maisAntiga);
    removidos.push(maisAntiga);
  }
  return removidos;
}

/**
 * Sistemas já descobertos, por endereço.
 *
 * NÃO é por universo, ao contrário de tudo o mais nesta sala. O endereço de um
 * sistema identifica um lugar na galáxia, que é a mesma em qualquer partida —
 * então a descoberta acompanha o lugar, não o seed da sala.
 *
 * `endereco -> { endereco, nome, descobridor, quando }`
 * @type {Map<string, object>}
 */
const descobertas = new Map();

/** Serializa as escavações de um canal no formato que o `welcome` carrega. */
function terrenoParaLista(canal) {
  const saida = [];
  for (const [planetaId, mapa] of canal.terreno) {
    if (mapa.size > 0) saida.push([planetaId, [...mapa.values()]]);
  }
  return saida;
}

/** Serializa os props colhidos de um canal. */
function colhidosParaLista(canal) {
  const saida = [];
  for (const [chave, indices] of canal.colhidos) saida.push([chave, [...indices]]);
  return saida;
}

/**
 * Tudo o que um cliente precisa para materializar um sistema.
 *
 * Sai no `welcome` (entrada na sala) e no `mundo` (troca de sistema): são o
 * mesmo conteúdo em momentos diferentes, e uma função só evita que os dois
 * caminhos divirjam — que é exatamente o tipo de diferença que só aparece
 * depois de um salto, com o jogador dentro de um planeta que não deveria ter
 * carregado.
 */
function retratoDoCanal(canal, exceto) {
  return {
    seed: canal.seed,
    colhidos: colhidosParaLista(canal),
    // Com o `frame` de volta em TODOS os eventos: quem chega agora nunca viu a
    // criação da base e não teria como situá-la.
    construcoes: [...canal.construcoes.values()].map((e) => ({
      ...e,
      frame: canal.frames.get(e.base) ?? null,
    })),
    terreno: terrenoParaLista(canal),
    jogadores: [...canal.presentes]
      .filter((id) => id !== exceto)
      .map((id) => jogadores.get(id))
      .filter(Boolean)
      .map((j) => ({ id: j.id, nome: j.nome, estado: j.estado })),
  };
}

// As descobertas são da GALÁXIA, não de um sistema: valem em todo canal e por
// isso continuam sendo carregadas de uma vez, no boot.
if (banco.disponivel) {
  for (const linha of await banco.carregarDescobertas()) {
    descobertas.set(linha.endereco, {
      endereco: linha.endereco,
      nome: linha.nome,
      descobridor: linha.descobridor,
      quando: linha.quando instanceof Date ? linha.quando.toISOString() : linha.quando,
    });
  }
  console.log(`[db] ${descobertas.size} sistemas descobertos restaurados`);
}

/** Conta autenticada por conexão, quando houver banco. @type {Map<number,{contaId:number,login:string}>} */
const contas = new Map();

let proximoId = 1;

function enviar(socket, mensagem) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(mensagem));
}

/**
 * Envia para todos os jogadores de UM canal.
 *
 * A antiga `transmitir` mandava para a sala inteira, e era ela que fazia dois
 * jogadores em sistemas diferentes se enxergarem. Toda difusão passa a exigir
 * o canal: não existe mais um caminho que alcance a sala toda por engano.
 */
function transmitirNoCanal(canal, mensagem, exceto) {
  const texto = JSON.stringify(mensagem);
  for (const id of canal.presentes) {
    if (id === exceto) continue;
    const jogador = jogadores.get(id);
    if (jogador?.socket.readyState === jogador?.socket.OPEN) jogador.socket.send(texto);
  }
}

/**
 * Difusão para a SALA INTEIRA, atravessando canais.
 *
 * Sobrou para as duas coisas que não pertencem a um sistema: o catálogo de
 * descobertas (é da galáxia) e o chat global. Tudo o mais passa por
 * `transmitirNoCanal` — o nome longo aqui é de propósito, para que usar o
 * alcance errado seja uma escolha visível no código.
 */
function transmitirParaTodos(mensagem, exceto) {
  const texto = JSON.stringify(mensagem);
  for (const jogador of jogadores.values()) {
    if (jogador.id === exceto) continue;
    if (jogador.socket.readyState === jogador.socket.OPEN) jogador.socket.send(texto);
  }
}

/** Tira o jogador do canal atual, avisando quem fica. */
function sairDoCanal(jogador) {
  const canal = canais.get(jogador.seed);
  if (!canal) return;
  canal.presentes.delete(jogador.id);
  transmitirNoCanal(canal, { type: 'saiu', id: jogador.id });
  // O canal vazio fica na memória de propósito: quem sai de um sistema
  // costuma voltar, e o estado dele é pequeno perto do custo de reler o banco.
}

/** Põe o jogador num canal e devolve o retrato para ele. */
async function entrarNoCanal(jogador, seed) {
  const canal = canalDe(seed);
  await prepararCanal(canal);

  jogador.seed = canal.seed;
  // A posição antiga é de OUTRO sistema: mantê-la faria o avatar aparecer no
  // canal novo nas coordenadas do planeta anterior, até o primeiro pacote.
  jogador.estado = null;
  canal.presentes.add(jogador.id);

  transmitirNoCanal(canal, { type: 'entrou', id: jogador.id, nome: jogador.nome }, jogador.id);
  return canal;
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
            // O progresso mais RECENTE, seja de qual sistema for.
            //
            // A tabela é (conta, seed) — uma linha por sistema visitado —, e
            // pedir a do sistema de entrada devolveria o estado de um lugar
            // onde a pessoa talvez não esteja há semanas. O estado guardado já
            // carrega o campo `sistema`, então o cliente sabe para onde voltar.
            const progresso = await banco.carregarProgressoMaisRecente(resultado.id);
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
        // O progresso é gravado no sistema em que o jogador ESTÁ.
        banco
          .salvarProgresso(conta.contaId, jogadores.get(id)?.seed ?? SEED, mensagem.progresso ?? {})
          .catch((erro) => console.error('[db] falha ao salvar progresso:', erro.message));
        break;
      }

      case 'join': {
        const nome = String(mensagem.nome ?? `Piloto ${id}`).slice(0, 24);
        // O cliente diz em que sistema está; sem isso, cai no de entrada.
        const seed = Number.isFinite(mensagem.seed) ? mensagem.seed >>> 0 : SEED;
        const jogador = { id, nome, socket, estado: null, seed };
        jogadores.set(id, jogador);

        entrarNoCanal(jogador, seed).then((canal) => {
          enviar(socket, {
            type: 'welcome',
            id,
            ...retratoDoCanal(canal, id),
            // O catálogo de descobertas é da GALÁXIA e vai inteiro, uma vez. São
            // ~40 bytes por sistema DESCOBERTO (não por sistema existente),
            // então mesmo uma campanha longa cabe em alguns quilobytes — e
            // mandar sob demanda exigiria um pedido a cada estrela que o cursor
            // toca no mapa.
            descobertas: [...descobertas.values()],
          });
          console.log(
            `[mp] ${nome} (#${id}) entrou no sistema ${canal.seed} — ` +
            `${canal.presentes.size} ali, ${jogadores.size} na sala`
          );
        });
        break;
      }

      case 'sistema': {
        // ---------------------------------------------------------------
        // TROCA DE CANAL — é o que o hiperimpulsor virou do lado da rede.
        //
        // Chega no auge do clarão do salto, quando o cliente já trocou o
        // universo local. A ordem importa: sair do canal antigo ANTES de
        // entrar no novo, senão um jogador que salta e volta ao mesmo
        // sistema apareceria duplicado para quem ficou.
        // ---------------------------------------------------------------
        const jogador = jogadores.get(id);
        if (!jogador || !Number.isFinite(mensagem.seed)) return;
        const destino = mensagem.seed >>> 0;
        if (destino === jogador.seed) return;

        sairDoCanal(jogador);
        entrarNoCanal(jogador, destino).then((canal) => {
          enviar(socket, { type: 'mundo', ...retratoDoCanal(canal, id) });
          console.log(`[mp] ${jogador.nome} (#${id}) saltou para o sistema ${canal.seed} — ${canal.presentes.size} ali`);
        });
        break;
      }

      case 'state': {
        const jogador = jogadores.get(id);
        if (!jogador) return;
        jogador.estado = mensagem.estado;
        // Repassa cru e SÓ para o canal: o pacote já vem no formato que o
        // cliente consome, e reempacotar por jogador multiplicaria o custo por
        // conexão.
        transmitirNoCanal(canalDe(jogador.seed), { type: 'state', id, estado: mensagem.estado }, id);
        break;
      }

      case 'construcao': {
        const jogadorC = jogadores.get(id);
        if (!jogadorC) return;
        const canal = canalDe(jogadorC.seed);
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
          if (!canal.construcoes.delete(chave)) return;
          banco
            .removerConstrucao(canal.seed, evento.base, evento.cel, evento.face)
            .catch((erro) => console.error('[db] falha ao demolir:', erro.message));
        } else {
          // Slot ocupado: dois jogadores construíram no mesmo lugar no mesmo
          // instante. O primeiro pacote a chegar vence e o segundo é descartado
          // — sem isso, os dois clientes ficariam com peças diferentes ali.
          if (canal.construcoes.has(chave)) return;
          if (typeof evento.peca !== 'string' || evento.peca.length > 24) return;

          if (evento.frame) canal.frames.set(evento.base, evento.frame);
          canal.construcoes.set(chave, evento);
          banco
            .gravarConstrucao(canal.seed, evento, canal.frames.get(evento.base))
            .catch((erro) => console.error('[db] falha ao gravar construção:', erro.message));
        }

        transmitirNoCanal(canal, { type: 'construcao', evento }, id);
        break;
      }

      case 'terreno': {
        const jogadorT = jogadores.get(id);
        if (!jogadorT) return;
        const canal = canalDe(jogadorT.seed);
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
        terrenoDoPlaneta(canal, mensagem.planeta).set(edicao.id, edicao);
        banco
          .gravarTerreno(canal.seed, mensagem.planeta, edicao)
          .catch((erro) => console.error('[db] falha ao gravar terreno:', erro.message));
        transmitirNoCanal(canal, { type: 'terreno', planeta: mensagem.planeta, edicao }, id);

        // Orçamento: as escavações mais antigas do planeta são abandonadas e o
        // relevo volta ao procedural ali. Avisa TODO MUNDO, inclusive quem
        // acabou de cavar — do contrário cada cliente teria uma ideia diferente
        // de quais buracos ainda existem.
        const expiradas = podarTerreno(canal, mensagem.planeta);
        if (expiradas.length > 0) {
          banco
            .removerTerreno(canal.seed, mensagem.planeta, expiradas)
            .catch((erro) => console.error('[db] falha ao podar terreno:', erro.message));
          transmitirNoCanal(canal, { type: 'terreno-expirado', planeta: mensagem.planeta, ids: expiradas });
          enviar(socket, { type: 'terreno-expirado', planeta: mensagem.planeta, ids: expiradas });
        }
        break;
      }

      case 'descobrir': {
        // -------------------------------------------------------------------
        // QUEM CHEGA PRIMEIRO FICA COM O CRÉDITO — E O SERVIDOR É QUEM DECIDE.
        //
        // O cliente reivindica todo sistema em que entra, inclusive um que ele
        // já visitou e um que outra pessoa descobriu ontem. Deixar assim é
        // deliberado: a alternativa é o cliente perguntar antes de reivindicar,
        // o que dobra as mensagens para evitar um custo que aqui é um `has` num
        // Map. E o cliente não teria como decidir sozinho de qualquer forma —
        // ele só conhece o catálogo do momento em que entrou.
        // -------------------------------------------------------------------
        const jogador = jogadores.get(id);
        if (!jogador) return;

        const endereco = String(mensagem.endereco ?? '').slice(0, 19);
        const nome = String(mensagem.nome ?? '').slice(0, 48);
        if (!endereco || !nome) return;
        if (descobertas.has(endereco)) return;

        const registro = {
          endereco,
          nome,
          descobridor: jogador.nome,
          quando: new Date().toISOString(),
        };
        descobertas.set(endereco, registro);

        banco
          .registrarDescoberta(endereco, nome, jogador.nome, contas.get(id)?.contaId ?? null)
          .catch((erro) => console.error('[db] falha ao gravar descoberta:', erro.message));

        // Para TODOS, inclusive quem reivindicou: é a confirmação de que o
        // crédito é dele, e o cliente não marca nada antes de receber isto. O
        // `exceto` no `transmitir` evita que o autor receba a mesma mensagem
        // duas vezes — inofensivo (o registro é idempotente), mas confunde
        // qualquer um que abra o inspetor de rede para entender o protocolo.
        // A descoberta é da GALÁXIA: vale para todo mundo, em qualquer sistema.
        // É a única difusão que continua atravessando os canais, e é o que
        // permite ver no mapa que alguém plantou bandeira do outro lado do
        // braço espiral enquanto você explorava aqui.
        transmitirParaTodos({ type: 'descoberta', ...registro }, id);
        enviar(socket, { type: 'descoberta', ...registro });
        console.log(`[mp] ${jogador.nome} descobriu ${nome}`);
        break;
      }

      case 'harvest': {
        const jogadorH = jogadores.get(id);
        if (!jogadorH) return;
        const canal = canalDe(jogadorH.seed);
        const chave = `${mensagem.planeta}:${mensagem.chunk}`;
        let indices = canal.colhidos.get(chave);
        if (!indices) canal.colhidos.set(chave, (indices = new Set()));
        // Já colhido: não retransmite. Sem esta guarda, dois jogadores mirando
        // o mesmo arbusto geram um eco infinito entre clientes.
        if (indices.has(mensagem.indice)) return;
        indices.add(mensagem.indice);
        banco
          .registrarColheita(canal.seed, mensagem.planeta, mensagem.chunk, mensagem.indice)
          .catch((erro) => console.error('[db] falha ao gravar colheita:', erro.message));
        transmitirNoCanal(
          canal,
          { type: 'harvest', planeta: mensagem.planeta, chunk: mensagem.chunk, indice: mensagem.indice },
          id
        );
        break;
      }

      /* ==================================================================
         CHAT
         ==================================================================
         Dois alcances, e a diferença entre eles é a razão de o chat existir
         num jogo de galáxia: o LOCAL só chega a quem está no mesmo sistema —
         é conversa com quem está no mesmo lugar — e o GLOBAL atravessa tudo,
         que é o único canal por onde duas pessoas separadas por mil
         anos-luz conseguem combinar de se encontrar.

         O servidor carimba o autor: o cliente manda apenas o texto. Deixar o
         nome vir do pacote seria deixar qualquer um assinar como qualquer um.
         ================================================================== */
      case 'chat': {
        const jogador = jogadores.get(id);
        if (!jogador) return;

        const texto = String(mensagem.texto ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!texto) return;

        // Limite de vazão por conexão: uma mensagem a cada 700 ms. Um cliente
        // modificado poderia inundar a sala inteira, e o custo de segurar isto
        // é um número por jogador.
        const agora = Date.now();
        if (agora - (jogador.ultimoChat ?? 0) < 700) return;
        jogador.ultimoChat = agora;

        const global = mensagem.escopo === 'global';
        const pacote = {
          type: 'chat',
          escopo: global ? 'global' : 'local',
          de: jogador.nome,
          id: jogador.id,
          texto,
          quando: agora,
        };

        if (global) transmitirParaTodos(pacote);
        else transmitirNoCanal(canalDe(jogador.seed), pacote);
        break;
      }
    }
  });

  socket.on('close', () => {
    const jogador = jogadores.get(id);
    if (!jogador) return;
    sairDoCanal(jogador);
    jogadores.delete(id);
    contas.delete(id);
    console.log(`[mp] ${jogador.nome} (#${id}) saiu — ${jogadores.size} na sala`);
  });
});

console.log(`[mp] sala aberta em ws://localhost:${PORTA} · seed ${SEED}`);
