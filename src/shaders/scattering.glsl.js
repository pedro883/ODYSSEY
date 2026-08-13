/**
 * Funções de espalhamento compartilhadas entre a casca de atmosfera
 * (`AtmosphereShader.js`) e o pass de perspectiva aérea
 * (`AerialPerspective.js`).
 *
 * Os dois integram a MESMA física em trechos diferentes do mesmo raio: a casca
 * cobre o que sobra depois do terreno (o céu), o pass cobre o que está entre a
 * câmera e o terreno. Se as funções divergissem — um `scaleHeight` diferente,
 * uma constante de fase trocada — o horizonte ganharia uma emenda visível
 * exatamente na linha onde um termina e o outro começa.
 */

export const SCATTERING_GLSL = /* glsl */ `
  /**
   * Interseção raio/esfera centrada na origem.
   * Devolve vec2(tEntrada, tSaida); x > y significa "sem interseção".
   */
  vec2 raySphere(vec3 origin, vec3 dir, float radius) {
    float b = dot(origin, dir);
    float c = dot(origin, origin) - radius * radius;
    float disc = b * b - c;
    if (disc < 0.0) return vec2(1.0, -1.0);
    float s = sqrt(disc);
    return vec2(-b - s, -b + s);
  }

  /** Densidade relativa do ar na altitude do ponto (perfil exponencial). */
  float airDensity(vec3 p, float planetRadius, float thickness, float scaleHeight) {
    float h = (length(p) - planetRadius) / thickness;
    return exp(-clamp(h, 0.0, 1.0) / scaleHeight);
  }

  /** Fase de Rayleigh: simétrica, levemente mais forte para frente e para trás. */
  float phaseRayleigh(float mu) {
    return 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  }

  /** Fase de Mie (Henyey-Greenstein): o halo concentrado ao redor do sol. */
  float phaseMie(float mu, float g) {
    float g2 = g * g;
    return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu * mu)) /
           ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
  }

  /**
   * Sombra do próprio planeta sobre um ponto da atmosfera — o terminador.
   * A borda é suavizada de propósito: a penumbra real tem centenas de km e um
   * corte duro parece recorte de papel.
   */
  float planetShadow(vec3 p, vec3 sunDirection, float planetRadius) {
    float along = dot(p, sunDirection);
    if (along > 0.0) return 1.0;
    float perpendicular = length(p - sunDirection * along);
    return smoothstep(planetRadius * 0.985, planetRadius * 1.03, perpendicular);
  }
`;
