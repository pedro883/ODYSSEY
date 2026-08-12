/**
 * HUD em HTML/CSS sobre o canvas.
 *
 * POR QUE NÃO DESENHAR NO CANVAS: texto em WebGL exige atlas de fontes,
 * geometria por glifo e um draw call por painel — e fica pior em telas HiDPI.
 * O compositor do browser desenha DOM na GPU de graça, com antialiasing
 * subpixel nativo. O único cuidado é o custo de escrita no DOM.
 *
 * POR ISSO O THROTTLE: atualizar 20 elementos a 144 Hz é layout thrashing puro.
 * O texto vai a 10 Hz (imperceptível para números) e só as barras e marcadores,
 * que usam `width`/`transform` e não causam reflow, acompanham o frame.
 */

import * as THREE from 'three';

const TEXT_INTERVAL = 0.1; // segundos
/** 2*pi*r do círculo do retículo (r = 16). */
const RETICLE_CIRCUMFERENCE = 100.5;

const _projected = new THREE.Vector3();

export class HUD {
  constructor() {
    const el = (id) => document.getElementById(id);

    this.root = el('hud');
    this.banner = el('hud-banner');
    this.prompt = el('prompt');
    this.miningArc = el('mining-arc');
    this.markerRoot = el('markers');

    this.discovery = {
      root: el('discovery'),
      name: el('disc-name'),
      sub: el('disc-sub'),
      units: el('disc-units'),
    };

    this.fields = {
      speed: el('hud-speed'),
      altitude: el('hud-altitude'),
      state: el('hud-state'),
      planet: el('hud-planet'),
      class: el('hud-class'),
      biome: el('hud-biome'),
      lat: el('hud-lat'),
      lon: el('hud-lon'),
      catalog: el('hud-catalog'),
      fps: el('hud-fps'),
      chunks: el('hud-chunks'),
      queue: el('hud-queue'),
      props: el('hud-props'),
      cache: el('hud-cache'),
      units: el('hud-units'),
      slots: el('hud-slots'),
    };

    this.bars = {
      throttle: el('hud-throttle'),
      jetpack: el('hud-jetpack'),
      shield: el('hud-shield'),
      atmo: el('hud-atmo'),
    };

    this.meters = {
      throttle: el('meter-throttle'),
      jetpack: el('meter-jetpack'),
    };

    this.itemList = el('hud-items');

    this._accumulator = 0;
    this._bannerTimer = 0;
    this._discoveryTimer = 0;
    this._cache = {};
    this._itemsSignature = '';
    /** @type {Map<string, HTMLElement>} */
    this._markers = new Map();
  }

  show() {
    this.root.classList.remove('hidden');
  }

  /** Escreve só se o valor mudou — evita invalidar layout à toa. */
  _set(key, value) {
    if (this._cache[key] === value) return;
    this._cache[key] = value;
    this.fields[key].textContent = value;
  }

  /**
   * @param {number} dt
   * @param {object} data
   */
  update(dt, data) {
    // Barras e anel: `width`/`stroke-dashoffset` num elemento posicionado não
    // disparam reflow do documento, então podem rodar a cada frame.
    this.bars.throttle.style.width = `${(data.throttle * 100).toFixed(0)}%`;
    this.bars.jetpack.style.width = `${(data.jetpack * 100).toFixed(0)}%`;
    this.bars.shield.style.width = `${(data.shield * 100).toFixed(0)}%`;
    this.bars.atmo.style.width = `${(data.atmosphere * 100).toFixed(0)}%`;

    this.miningArc.style.strokeDashoffset =
      RETICLE_CIRCUMFERENCE * (1 - data.miningProgress);

    // Só o medidor relevante ao modo atual fica visível.
    this.meters.throttle.classList.toggle('off', data.onFoot);
    this.meters.jetpack.classList.toggle('off', !data.onFoot);

    if (this._bannerTimer > 0) {
      this._bannerTimer -= dt;
      if (this._bannerTimer <= 0) this.banner.classList.remove('show');
    }
    if (this._discoveryTimer > 0) {
      this._discoveryTimer -= dt;
      if (this._discoveryTimer <= 0) this.discovery.root.classList.add('hidden');
    }

    this._accumulator += dt;
    if (this._accumulator < TEXT_INTERVAL) return;
    this._accumulator = 0;

    this._set('speed', data.speed.toFixed(0));
    this._set('altitude', formatDistance(data.altitude));
    this._set('state', data.phase);
    this._set('planet', data.planetName);
    this._set('class', data.planetClass);
    this._set('biome', data.biome);
    this._set('lat', `${data.latitude.toFixed(1)}°`);
    this._set('lon', `${data.longitude.toFixed(1)}°`);
    this._set('catalog', data.cataloged ? 'REGISTRADO' : 'DESCONHECIDO');
    this._set('fps', data.fps.toFixed(0));
    this._set('chunks', String(data.chunks));
    this._set('queue', String(data.queue));
    this._set('props', formatCount(data.props));
    this._set('cache', `${(data.cacheHitRate * 100).toFixed(0)}%`);
    this._set('units', data.units.toLocaleString('pt-BR'));
    this._set('slots', `${data.slotsUsed}/${data.slots}`);

    this._renderItems(data.items);
  }

  _renderItems(items) {
    // Reconstruir a lista é barato, mas só quando ela muda de verdade —
    // caso contrário seriam 10 recriações de DOM por segundo à toa.
    const signature = items.map((i) => `${i.id}:${i.amount}`).join('|');
    if (signature === this._itemsSignature) return;
    this._itemsSignature = signature;

    if (items.length === 0) {
      this.itemList.innerHTML = '<li class="empty">vazio</li>';
      return;
    }

    this.itemList.innerHTML = items
      .map((item) => {
        const hex = `#${item.cor.toString(16).padStart(6, '0')}`;
        return `<li><span class="dot" style="background:${hex}"></span>${item.nome}<span class="qty">${item.amount}</span></li>`;
      })
      .join('');
  }

  /* ===================================================================== */
  /* Marcadores no espaço da tela                                          */
  /* ===================================================================== */

  /**
   * Projeta pontos do mundo para a tela. É o que permite achar a nave depois
   * de caminhar 300 m e escolher para qual planeta viajar sem abrir um mapa.
   *
   * @param {THREE.Camera} camera
   * @param {Array<{id:string, position:THREE.Vector3, label:string, sub:string, kind:string}>} list
   */
  updateMarkers(camera, list) {
    const seen = new Set();
    const halfW = window.innerWidth / 2;
    const halfH = window.innerHeight / 2;

    for (const item of list) {
      _projected.copy(item.position).project(camera);

      // z > 1 significa atrás da câmera: projetar assim mesmo colocaria o
      // marcador espelhado no lado errado da tela.
      if (_projected.z > 1) continue;

      const x = (_projected.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-_projected.y * 0.5 + 0.5) * window.innerHeight;

      // Mantém o marcador dentro da tela, com uma margem, para não sumir
      // exatamente quando o jogador precisa dele.
      const cx = Math.max(40, Math.min(window.innerWidth - 40, x));
      const cy = Math.max(30, Math.min(window.innerHeight - 30, y));

      let node = this._markers.get(item.id);
      if (!node) {
        node = document.createElement('div');
        node.className = `marker marker--${item.kind}`;
        node.innerHTML = '<span class="glyph"></span><span class="label"></span><span class="dist"></span>';
        this.markerRoot.appendChild(node);
        this._markers.set(item.id, node);
      }

      node.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
      const label = node.querySelector('.label');
      const dist = node.querySelector('.dist');
      if (label.textContent !== item.label) label.textContent = item.label;
      if (dist.textContent !== item.sub) dist.textContent = item.sub;
      node.style.opacity = '1';
      seen.add(item.id);
    }

    for (const [id, node] of this._markers) {
      if (!seen.has(id)) node.style.opacity = '0';
    }
  }

  /* ===================================================================== */
  /* Mensagens                                                             */
  /* ===================================================================== */

  /** Prompt contextual (`null` esconde). */
  setPrompt(html) {
    if (!html) {
      this.prompt.classList.add('hidden');
      return;
    }
    if (this.prompt.innerHTML !== html) this.prompt.innerHTML = html;
    this.prompt.classList.remove('hidden');
  }

  /** Mensagem temporária no centro da tela. */
  notify(text, duration = 2.6) {
    this.banner.textContent = text;
    this.banner.classList.add('show');
    this._bannerTimer = duration;
  }

  /** Cartão de descoberta. */
  showDiscovery(nome, subtitulo, unidades, duration = 4.5) {
    this.discovery.name.textContent = nome;
    this.discovery.sub.textContent = subtitulo;
    this.discovery.units.textContent = `+${unidades.toLocaleString('pt-BR')} unidades`;
    this.discovery.root.classList.remove('hidden');
    this._discoveryTimer = duration;
  }
}

function formatDistance(value) {
  const abs = Math.abs(value);
  if (abs >= 100000) return `${(value / 1000).toFixed(0)}k`;
  if (abs >= 10000) return `${(value / 1000).toFixed(1)}k`;
  return value.toFixed(0);
}

function formatCount(value) {
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(value);
}

/**
 * Converte uma direção unitária em latitude/longitude (graus).
 * Y é o eixo polar do planeta, coerente com `temperatureAt` em terrain.js.
 */
export function toLatLon(direction) {
  const latitude = Math.asin(Math.max(-1, Math.min(1, direction.y))) * (180 / Math.PI);
  const longitude = Math.atan2(direction.z, direction.x) * (180 / Math.PI);
  return { latitude, longitude };
}
