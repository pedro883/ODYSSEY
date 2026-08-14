/**
 * Som do jogo, inteiramente SINTETIZADO em Web Audio.
 *
 * ---------------------------------------------------------------------------
 * POR QUE NENHUM ARQUIVO DE ÁUDIO
 * ---------------------------------------------------------------------------
 * O projeto inteiro se sustenta numa ideia: nada é armazenado, tudo é função de
 * um seed. Um motor de nave em .mp3 seria o único lugar do jogo onde um mundo
 * gerado proceduralmente soa exatamente igual em todos os planetas — e ainda
 * custaria alguns MB num bundle que já carrega texturas de árvore embutidas.
 *
 * Osciladores e ruído filtrado resolvem tudo o que este jogo precisa e ainda
 * dão de graça o que uma amostra não dá: o motor não toca um loop, ele MUDA de
 * timbre com o acelerador; o vento não é um sample em fade, é ruído cuja banda
 * abre conforme a atmosfera engrossa.
 *
 * ---------------------------------------------------------------------------
 * DUAS REGRAS QUE GOVERNAM O ARQUIVO INTEIRO
 * ---------------------------------------------------------------------------
 * 1. **O `AudioContext` só nasce num gesto do usuário.** Todo navegador
 *    moderno bloqueia áudio antes disso, e um contexto criado no boot nasce
 *    `suspended` — o jogo ficaria mudo sem nenhum erro no console, que é o
 *    tipo de bug que se descobre tarde. Por isso `start()` é chamado no clique
 *    do botão de início, e não no import.
 *
 * 2. **Osciladores são criados UMA vez e nunca param.** A tentação é ligar e
 *    desligar o oscilador do motor conforme o acelerador; o resultado é um
 *    clique a cada mudança (descontinuidade na forma de onda) e alocação por
 *    frame. Aqui cada camada tem um `GainNode` que faz de torneira, e todo
 *    parâmetro anda por `setTargetAtTime` — que interpola em rampa
 *    exponencial e nunca estala.
 */

const NOISE_SECONDS = 2;

/** Suavização padrão dos parâmetros contínuos, em segundos. */
const SMOOTH = 0.08;

export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} enquanto não houver gesto do usuário. */
    this.ctx = null;
    this.ready = false;

    // A preferência sobrevive ao F5. Um jogo que volta com som ligado depois
    // de você desligar é uma pequena traição.
    this.muted = localStorage.getItem('nms.mute') === '1';
    // Conservador de propósito: som de jogo que chega alto demais é a primeira
    // coisa que o jogador desliga, e aí ele perde tudo, inclusive o que estava
    // bom. `__nms.audio.setVolume()` ajusta em tempo real.
    this.volume = 0.5;
  }

  /* ===================================================================== */
  /* Construção do grafo                                                    */
  /* ===================================================================== */

  /** Chamado a partir de um gesto do usuário (clique em "iniciar"). */
  start() {
    if (this.ctx) {
      // Voltar de outra aba deixa o contexto suspenso; retomar é barato e
      // idempotente.
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }

    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctx) return; // navegador sem Web Audio: o jogo segue mudo

    const ctx = new Ctx();
    this.ctx = ctx;

    // --- Barramento principal ---------------------------------------------
    // O compressor não é enfeite: várias camadas contínuas somadas (motor +
    // vento + pulse) estouram fácil, e clipping digital é o som mais feio que
    // existe. Com ele, um pico apenas "encolhe" o resto por um instante.
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.18;

    this.master.connect(limiter);
    limiter.connect(ctx.destination);

    this._buildNoise();
    this._buildEngine();
    this._buildWind();
    this._buildChuva();
    this._buildPulse();
    this._buildBeam();

    this.ready = true;
  }

  /**
   * Uma fonte de ruído branco, em loop, compartilhada por todas as camadas.
   *
   * Gerar ruído por `ScriptProcessor`/`AudioWorklet` seria desperdício: dois
   * segundos de buffer em loop são indistinguíveis de ruído infinito depois de
   * passar por um filtro, e custam uma alocação só.
   */
  _buildNoise() {
    const ctx = this.ctx;
    const length = ctx.sampleRate * NOISE_SECONDS;
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;

    this.noiseBuffer = buffer;
  }

  /** Fonte de ruído em loop já tocando, para ligar a um filtro. */
  _noiseSource() {
    const source = this.ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    source.start();
    return source;
  }

  /**
   * Motor: dois dentes-de-serra desafinados + um sub senoidal, num passa-baixa.
   *
   * A desafinação (`detune`) é o que separa "motor" de "apito": dois osciladores
   * a poucos cents de distância batem entre si e produzem a modulação lenta que
   * o ouvido lê como máquina. Um oscilador só, por mais grave, soa como teste
   * de linha telefônica.
   */
  _buildEngine() {
    const ctx = this.ctx;

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;

    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 400;
    this.engineFilter.Q.value = 1.2;

    this.engineOsc = [];
    for (const detune of [-9, 7]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 60;
      osc.detune.value = detune;
      osc.connect(this.engineFilter);
      osc.start();
      this.engineOsc.push(osc);
    }

    // Sub: dá peso sem sujar o médio, que é onde o vento vive.
    this.engineSub = ctx.createOscillator();
    this.engineSub.type = 'sine';
    this.engineSub.frequency.value = 30;
    this.engineSub.connect(this.engineFilter);
    this.engineSub.start();

    // Sopro do booster: ruído que só aparece com o acelerador no fim do curso.
    this.thrustGain = ctx.createGain();
    this.thrustGain.gain.value = 0;
    const thrustFilter = ctx.createBiquadFilter();
    thrustFilter.type = 'bandpass';
    thrustFilter.frequency.value = 900;
    thrustFilter.Q.value = 0.7;
    this._noiseSource().connect(thrustFilter);
    thrustFilter.connect(this.thrustGain);
    this.thrustGain.connect(this.engineGain);

    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);
  }

  /**
   * Vento: ruído num passa-banda cuja frequência sobe com a velocidade.
   *
   * É a camada que faz a atmosfera ser SENTIDA e não só vista — no vácuo ela
   * fica em zero absoluto, e o silêncio do espaço passa a ser uma informação
   * de jogo, não uma ausência.
   */
  _buildWind() {
    const ctx = this.ctx;

    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;

    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 500;
    this.windFilter.Q.value = 0.55;

    this._noiseSource().connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);
  }

  /**
   * Precipitação: ruído filtrado, separado do vento.
   *
   * Podia sair da mesma camada do vento com outra frequência, e não sai por um
   * motivo prático: as duas tocam JUNTAS. Chove com vento, e um único
   * oscilador teria de escolher entre soar como um ou como outro. Chuva é
   * banda alta e chiada, ventania de areia é banda média e áspera — com dois
   * ganhos independentes, o mesmo par de nós cobre os dois climas e a mistura
   * entre eles.
   */
  _buildChuva() {
    const ctx = this.ctx;

    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;

    this.rainFilter = ctx.createBiquadFilter();
    this.rainFilter.type = 'highpass';
    this.rainFilter.frequency.value = 1800;

    this._noiseSource().connect(this.rainFilter);
    this.rainFilter.connect(this.rainGain);
    this.rainGain.connect(this.master);
  }

  /** Pulse drive: um zumbido agudo que sobe junto com a rampa de engate. */
  _buildPulse() {
    const ctx = this.ctx;

    this.pulseGain = ctx.createGain();
    this.pulseGain.gain.value = 0;

    this.pulseOsc = ctx.createOscillator();
    this.pulseOsc.type = 'triangle';
    this.pulseOsc.frequency.value = 120;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1400;
    filter.Q.value = 3;
    this._noiseSource().connect(filter);

    this.pulseOsc.connect(this.pulseGain);
    filter.connect(this.pulseGain);
    this.pulseOsc.start();
    this.pulseGain.connect(this.master);
  }

  /**
   * Feixe de mineração: serra grave com trêmulo rápido.
   *
   * ---------------------------------------------------------------------
   * O TRÊMULO PRECISA DE UM NÓ SÓ DELE — E ANTES DA TORNEIRA.
   * ---------------------------------------------------------------------
   * A versão anterior ligava o LFO direto em `beamGain.gain`, e isso era um
   * bug sério: um `AudioParam` vale `valor intrínseco + soma dos sinais
   * conectados`. Com o alvo em 0 (sem minerar), o ganho não ficava em zero —
   * ficava oscilando entre -0,5 e +0,5. Resultado: a serra grave tocava a
   * meio volume, picotada a 22 Hz, o tempo inteiro, em todo lugar do jogo.
   *
   * A correção é separar os papéis: `tremolo` oscila em torno de 0,5 (nunca
   * negativo) e `beamGain` é a torneira, que de fato fecha em zero.
   */
  _buildBeam() {
    const ctx = this.ctx;

    this.beamGain = ctx.createGain();
    this.beamGain.gain.value = 0;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 190;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1100;

    // O "zzzz" pulsante de ferramenta trabalhando. Sem ele o feixe soa como um
    // alarme parado.
    const tremolo = ctx.createGain();
    tremolo.gain.value = 0.5;

    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 22;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.45;
    lfo.connect(lfoDepth);
    lfoDepth.connect(tremolo.gain);
    lfo.start();

    osc.connect(filter);
    filter.connect(tremolo);
    tremolo.connect(this.beamGain);
    osc.start();
    this.beamGain.connect(this.master);
  }

  /* ===================================================================== */
  /* Camadas contínuas                                                      */
  /* ===================================================================== */

  /**
   * @param {number} dt
   * @param {object} s estado do frame
   * @param {number} s.throttle 0..1
   * @param {boolean} s.boost
   * @param {number} s.speed unidades/s
   * @param {number} s.atmosphere 0 = vácuo, 1 = solo
   * @param {number} s.pulseSpool 0..1
   * @param {boolean} s.onFoot
   * @param {boolean} s.mining
   * @param {boolean} s.jetpack
   */
  update(dt, s) {
    if (!this.ready || this.muted) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const set = (param, value) => param.setTargetAtTime(value, now, SMOOTH);

    // --- Motor --------------------------------------------------------------
    // A pé não há motor; o jetpack toma o lugar dele, mais agudo e mais fraco,
    // reaproveitando a mesma camada em vez de montar outra igual.
    if (s.onFoot) {
      set(this.engineGain.gain, s.jetpack ? 0.14 : 0);
      set(this.engineFilter.frequency, 900);
      set(this.engineOsc[0].frequency, 150);
      set(this.engineOsc[1].frequency, 152);
      set(this.engineSub.frequency, 74);
      set(this.thrustGain.gain, s.jetpack ? 0.5 : 0);
    } else {
      const drive = s.throttle * (s.boost ? 1 : 0.72);
      // A frequência sobe com o acelerador E com a velocidade real: acelerar
      // parado dá o "subir de giro", e ganhar velocidade dá o resto. Só com o
      // acelerador, o motor soa desconectado do que se vê pela janela.
      const speedRatio = Math.min(s.speed / 900, 1.6);
      const base = 46 + drive * 58 + speedRatio * 34;

      // OS DOIS OSCILADORES FICAM NA MESMA NOTA. Antes o segundo ia a
      // `base * 1.5` — uma quinta justa acima. Duas ondas dente-de-serra numa
      // quinta não soam como motor, soam como órgão de igreja desafinado: o
      // intervalo é consonante demais para ler como máquina e todos os
      // harmônicos se somam num zumbido áspero. O que produz "motor" é a
      // BATIDA entre duas ondas a poucos cents de distância, e disso já cuida
      // o `detune` (±9 cents) definido na construção.
      set(this.engineOsc[0].frequency, base);
      set(this.engineOsc[1].frequency, base);
      // O sub acompanha a fundamental em vez de descer uma oitava: a `base`
      // chega a 46 Hz, e metade disso é infrassom — energia que caixa nenhuma
      // reproduz e que só faz o alto-falante distorcer.
      set(this.engineSub.frequency, base);
      // O passa-baixa abrindo com o acelerador é o que dá a sensação de
      // potência: mais harmônicos passam, o timbre "abre".
      set(this.engineFilter.frequency, 260 + drive * 1500 + speedRatio * 400);
      // Marcha lenta quase inaudível: com o acelerador em zero no vácuo, o que
      // se quer ouvir é o silêncio do espaço, não um zumbido de fundo.
      set(this.engineGain.gain, 0.02 + drive * 0.16);
      set(this.thrustGain.gain, Math.max(0, drive - 0.55) * 0.5);
    }

    // --- Vento --------------------------------------------------------------
    // No vácuo, zero. Não é preciosismo: é a única pista sonora de que se saiu
    // da atmosfera, e ela chega antes de o céu terminar de escurecer.
    const speedWind = s.onFoot
      ? Math.min(s.speed / 18, 1) * 0.35
      : Math.min(s.speed / 500, 1);
    set(this.windGain.gain, s.atmosphere * (0.03 + speedWind * 0.2));
    set(this.windFilter.frequency, 320 + speedWind * 1600);

    // --- Clima ---------------------------------------------------------------
    // Só a pé e só dentro do ar: dentro da nave o motor cobre tudo, e no vácuo
    // não há meio para o som atravessar.
    const chuva = (s.chuva ?? 0) * s.atmosphere * (s.onFoot ? 1 : 0.35);
    set(this.rainGain.gain, chuva * 0.09);
    // Areia é grave e abafada; chuva é chiado agudo. Uma frequência de corte
    // cobre os dois extremos sem um segundo filtro.
    set(this.rainFilter.frequency, s.climaAreia ? 700 : 1800);

    // --- Pulse --------------------------------------------------------------
    set(this.pulseGain.gain, s.pulseSpool * 0.16);
    set(this.pulseOsc.frequency, 120 + s.pulseSpool * 520);

    // --- Feixe --------------------------------------------------------------
    // O `0.5` do LFO é somado a este valor (o LFO modula o MESMO AudioParam),
    // então o ganho oscila entre metade e o dobro do que está aqui.
    set(this.beamGain.gain, s.mining ? 0.1 : 0);
  }

  /* ===================================================================== */
  /* Sons pontuais                                                          */
  /* ===================================================================== */

  /**
   * Toca uma nota curta com envelope ataque/decaimento.
   *
   * Cada disparo cria seu próprio oscilador e o AGENDA para parar. Aqui isso é
   * correto (ao contrário das camadas contínuas): um oscilador que já parou é
   * coletado pelo próprio navegador, e sons pontuais são raros o bastante para
   * a alocação não pesar.
   */
  _blip({ freq, type = 'sine', duration = 0.18, gain = 0.25, sweep = 0, delay = 0 }) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (sweep) osc.frequency.exponentialRampToValueAtTime(Math.max(freq + sweep, 20), t0 + duration);

    const env = ctx.createGain();
    // Ataque de 12 ms em vez de instantâneo: um degrau no ganho é um clique
    // audível, mesmo com o envelope decaindo logo em seguida.
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

    osc.connect(env);
    env.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  /** Estouro de ruído filtrado — impactos, passos, pouso. */
  _thump({ freq = 200, duration = 0.22, gain = 0.3, type = 'lowpass' }) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    // Começa num ponto aleatório do buffer: sem isso, todo passo ataca a mesma
    // sequência de amostras e o ouvido percebe a repetição como um "tique"
    // idêntico, que denuncia o truque na hora.
    const offset = Math.random() * (NOISE_SECONDS - duration - 0.05);

    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq * 2.2, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(freq * 0.5, 40), t0 + duration);
    filter.Q.value = 1.1;

    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, t0);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

    source.connect(filter);
    filter.connect(env);
    env.connect(this.master);
    source.start(t0, offset, duration + 0.05);
  }

  /** Pouso: peso proporcional à velocidade com que se chegou. */
  land(strength = 1) {
    const s = Math.min(strength, 1);
    this._thump({ freq: 90 + s * 60, duration: 0.3 + s * 0.2, gain: 0.18 + s * 0.3 });
  }

  /** Passo: alterna levemente o timbre para o par de pés não soar idêntico. */
  step(sprint = false) {
    this._thump({
      freq: 150 + Math.random() * 90,
      duration: 0.1,
      gain: sprint ? 0.13 : 0.08,
      type: 'bandpass',
    });
  }

  /** Varredura da multiferramenta: um "ping" que sobe. */
  scan() {
    this._blip({ freq: 620, type: 'sine', duration: 0.5, gain: 0.22, sweep: 900 });
    this._blip({ freq: 1240, type: 'sine', duration: 0.35, gain: 0.1, sweep: 700, delay: 0.04 });
  }

  /** Recurso coletado: nota curta e seca. */
  collect() {
    this._blip({ freq: 880, type: 'triangle', duration: 0.1, gain: 0.16 });
  }

  /**
   * Descoberta: arpejo maior ascendente.
   *
   * Terça e quinta justas (5/4 e 3/2). O intervalo é o que faz três notas
   * soarem como recompensa em vez de aviso — som de conquista é quase sempre
   * um acorde maior subindo.
   */
  discovery() {
    const base = 523.25; // dó5
    [1, 1.25, 1.5, 2].forEach((ratio, i) => {
      this._blip({
        freq: base * ratio,
        type: 'triangle',
        duration: 0.42,
        gain: 0.16,
        delay: i * 0.085,
      });
    });
  }

  /**
   * Peça construída: batida de encaixe + confirmação.
   *
   * Duas camadas, e é a combinação que faz soar como MONTAGEM. O baque grave
   * dá o peso do metal assentando; a nota curta logo acima confirma que o
   * encaixe pegou. Só o baque soaria como algo caindo; só a nota, como um
   * clique de menu.
   */
  build() {
    this._thump({ freq: 130, duration: 0.16, gain: 0.22, type: 'bandpass' });
    this._blip({ freq: 660, type: 'triangle', duration: 0.11, gain: 0.1, delay: 0.035 });
    this._blip({ freq: 990, type: 'sine', duration: 0.08, gain: 0.05, delay: 0.06 });
  }

  /** Peça demolida: o mesmo gesto ao contrário, e mais surdo. */
  demolish() {
    this._blip({ freq: 520, type: 'triangle', duration: 0.12, gain: 0.07, sweep: -260 });
    this._thump({ freq: 90, duration: 0.22, gain: 0.16, type: 'lowpass' });
  }

  /**
   * Terraformador: ruído contínuo enquanto o solo cede.
   *
   * Chamado a cada pá de terra, não uma vez por escavação — o intervalo entre
   * as batidas é o que comunica a velocidade do trabalho. A variação aleatória
   * de frequência evita o efeito de metralhadora que um timbre fixo repetido a
   * intervalo regular sempre produz.
   */
  terraform(cavando = true) {
    this._thump({
      freq: (cavando ? 110 : 170) + Math.random() * 70,
      duration: 0.14,
      gain: 0.1,
      type: 'bandpass',
    });
  }

  /** Engate do pulse: varredura ascendente longa. */
  pulseEngage() {
    this._blip({ freq: 180, type: 'sawtooth', duration: 1.1, gain: 0.12, sweep: 900 });
  }

  /** Corte do pulse: a mesma varredura ao contrário, mais curta. */
  pulseDisengage() {
    this._blip({ freq: 900, type: 'sawtooth', duration: 0.5, gain: 0.1, sweep: -760 });
  }

  /** Confirmação de interface (embarcar, sair, alternar modo). */
  ui(up = true) {
    this._blip({ freq: up ? 520 : 380, type: 'square', duration: 0.09, gain: 0.07 });
  }

  /** Entrada atmosférica: rugido grave e longo. */
  reentry() {
    this._thump({ freq: 320, duration: 1.6, gain: 0.22, type: 'bandpass' });
  }

  /* ===================================================================== */
  /* Controle                                                               */
  /* ===================================================================== */

  /**
   * Cala as camadas CONTÍNUAS: motor, propulsão, vento, pulse e feixe.
   *
   * Existe porque as camadas contínuas não são disparos com fim: são
   * osciladores ligados desde o `start()`, cujo volume é escrito a cada frame
   * por `update`. Parar de chamar `update` — o que acontece quando o jogo pausa
   * para o mapa galáctico — não silencia nada; congela o último valor e o motor
   * fica roncando indefinidamente sobre uma tela onde não há nave.
   *
   * A constante de tempo é maior que a de `update` (0.08 contra SMOOTH): o
   * corte é uma transição de contexto, e um desligamento abrupto do motor soa
   * como um defeito no som, não como uma pausa.
   *
   * Sons pontuais (blips da interface) continuam valendo — é justamente com um
   * deles que o mapa abre.
   */
  silenciarContinuos() {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    for (const g of [this.engineGain, this.thrustGain, this.windGain, this.rainGain, this.pulseGain, this.beamGain]) {
      g.gain.setTargetAtTime(0, now, 0.08);
    }
  }

  /** @param {number} value 0..1 */
  setVolume(value) {
    this.volume = Math.min(Math.max(value, 0), 1);
    if (this.ready && !this.muted) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
    }
    return this.volume;
  }

  /**
   * Nível de saída medido (RMS, 0..1).
   *
   * Existe para depuração: é o único jeito de responder "isso está tocando
   * alguma coisa?" sem confiar no ouvido de quem está com o fone tirado. O
   * analisador só é criado na primeira chamada — quem nunca depura não paga.
   */
  level() {
    if (!this.ready) return 0;
    if (!this._analyser) {
      this._analyser = this.ctx.createAnalyser();
      this._analyser.fftSize = 2048;
      this.master.connect(this._analyser);
      this._analyserData = new Float32Array(this._analyser.fftSize);
    }
    this._analyser.getFloatTimeDomainData(this._analyserData);
    let sum = 0;
    for (const v of this._analyserData) sum += v * v;
    return Math.sqrt(sum / this._analyserData.length);
  }

  toggleMute() {
    this.muted = !this.muted;
    localStorage.setItem('nms.mute', this.muted ? '1' : '0');
    if (this.ready) {
      this.master.gain.setTargetAtTime(
        this.muted ? 0 : this.volume,
        this.ctx.currentTime,
        0.05
      );
    }
    return this.muted;
  }

  dispose() {
    this.ctx?.close();
    this.ctx = null;
    this.ready = false;
  }
}

/** Instância única — o som é global, não por planeta. */
export const audio = new AudioEngine();
