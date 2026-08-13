/**
 * Pool de Web Workers com balanceamento por carga, compartilhado por todos os
 * planetas do sistema.
 *
 * Um worker só não basta: gerar terreno é CPU-bound e, ao mergulhar na
 * atmosfera, dezenas de chunks são pedidos ao mesmo tempo. Com um único worker
 * a fila cresce e o terreno aparece "pintado" aos poucos.
 *
 * Deixamos 2 núcleos livres de propósito: um para a main thread (render loop)
 * e outro para a thread de compositing/GPU do browser. Saturar todos os
 * núcleos com workers derruba o FPS mesmo com a main thread "livre".
 *
 * Por que UM pool para N planetas: 4 planetas × 6 workers seriam 24 threads
 * disputando 8 núcleos, com troca de contexto constante e nenhum ganho — só
 * um planeta está perto da câmera de cada vez. Cada worker guarda os
 * amostradores de todos os planetas registrados (~1 ms e alguns KB cada).
 */
export class WorkerPool {
  /**
   * @param {() => Worker} factory cria um worker novo (o Vite exige a forma
   *   `new Worker(new URL('./x.js', import.meta.url), { type: 'module' })`
   *   literal no código, por isso recebemos uma factory em vez de uma string)
   * @param {(data: any) => void} onResult callback para cada resultado
   * @param {number} [size]
   */
  constructor(factory, onResult, size) {
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    this.size = size ?? Math.max(2, Math.min(6, cores - 2));

    this.onResult = onResult;
    this.workers = [];
    this.load = new Int32Array(this.size);
    this.jobOwner = new Map(); // id do job -> índice do worker
    /** planetId -> quantos workers já confirmaram o registro. */
    this.registered = new Map();
    this.disposed = false;

    for (let i = 0; i < this.size; i++) {
      const worker = factory();
      worker.onmessage = (event) => this._handleMessage(i, event.data);
      worker.onerror = (err) => {
        console.error(`[WorkerPool] worker ${i} falhou:`, err.message ?? err);
      };
      this.workers.push(worker);
    }
  }

  /**
   * Ensina TODOS os workers a gerar terreno para este planeta.
   * @param {object[]} [edicoes] escavações já existentes (restauradas do banco)
   */
  register(planetId, config, edicoes) {
    this.registered.set(planetId, 0);
    for (const worker of this.workers) {
      worker.postMessage({ type: 'register', planetId, config, edicoes });
    }
  }

  /**
   * Propaga uma escavação para TODOS os workers.
   *
   * Todos, e não só o que vai gerar o chunk: o pool despacha pelo menos
   * ocupado, então qualquer um pode receber o pedido de qualquer região. Um
   * worker desatualizado devolveria um chunk com o buraco faltando, e o
   * jogador veria um retalho do terreno antigo aparecer no meio da cratera.
   */
  enviarEdicao(planetId, edicao) {
    for (const worker of this.workers) {
      worker.postMessage({ type: 'edicao', planetId, edicao });
    }
  }

  /** Substitui a lista inteira (restauração em bloco). */
  enviarEdicoes(planetId, lista) {
    for (const worker of this.workers) {
      worker.postMessage({ type: 'edicoes', planetId, lista });
    }
  }

  /** O planeta já pode receber pedidos de chunk? */
  isReady(planetId) {
    return this.registered.get(planetId) === this.size;
  }

  /** Número de jobs despachados e ainda não respondidos. */
  get inFlight() {
    let total = 0;
    for (let i = 0; i < this.size; i++) total += this.load[i];
    return total;
  }

  /**
   * Despacha um job para o worker menos ocupado.
   * @param {{id: number}} message precisa conter um `id` para rastreamento
   */
  dispatch(message) {
    if (this.disposed) return;

    let best = 0;
    for (let i = 1; i < this.size; i++) {
      if (this.load[i] < this.load[best]) best = i;
    }

    this.load[best]++;
    this.jobOwner.set(message.id, best);
    this.workers[best].postMessage(message);
  }

  _handleMessage(index, data) {
    if (data.type === 'registered') {
      this.registered.set(data.planetId, (this.registered.get(data.planetId) ?? 0) + 1);
      return;
    }

    if (this.jobOwner.delete(data.id)) {
      this.load[index]--;
    }
    if (!this.disposed) this.onResult(data);
  }

  dispose() {
    this.disposed = true;
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    this.jobOwner.clear();
  }
}
