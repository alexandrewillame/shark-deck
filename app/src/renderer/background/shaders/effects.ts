/**
 * One fragment shader per background — the `main()` that follows `COMMON`.
 *
 * Every effect draws in the theme's two colours (`uA`, `uB`) over the page
 * (`uBg`), so a palette change recolours it with nothing else to do. Emitters
 * finish through `glow()`, pictures through `scene()` (see common.ts).
 *
 * Each is a scene, drawn at night in the dark theme and in daylight in the
 * light one. The day is not the night recoloured: a night shows only what
 * glows, so each effect has its own `if (uLight > 0.5)` branch that lights
 * the SAME fields as a material — smoke as a shaded volume, water as a
 * surface in the sun — and so shows what the dark hides. That branch comes
 * after the fields it lights and before the night's own arithmetic; it reads
 * those fields rather than recomputing them and shares no sum with the night,
 * so the dark theme draws exactly as it did. The compiler optimises both
 * sides together, and such a slip once moved a few dark pixels by one step.
 */

/** Smoke: domain-warped fbm (fbm feeding fbm feeding fbm), drifting upward —
 *  heavier low down, thinning as it rises, its lit edges bleaching. By day the
 *  whole plume shows, thin wisps too, lit where it thins toward the light and
 *  shaded in its folds (one more fbm, a step toward the light). */
export const SMOKE = /* glsl */ `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes.y;
  float t = uTime * 0.035;
  vec2 p = uv * 1.6 + vec2(0.0, -t * 1.4);
  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - t));
  vec2 r = vec2(
    fbm(p + 1.8 * q + vec2(1.7, 9.2) + 0.4 * t),
    fbm(p + 1.8 * q + vec2(8.3, 2.8) - 0.3 * t)
  );
  float f = fbm(p + 1.6 * r);
  if (uLight > 0.5) {
    float toward = fbm(p + 1.6 * r + vec2(-0.05, 0.08));
    float body = smoothstep(0.34, 0.84, f);
    float lit = clamp(0.55 + (f - toward) * 5.0, 0.0, 1.0);
    vec3 hue = mix(uA, uB, smoothstep(0.3, 0.8, q.y));
    float thick = mix(1.0, 0.55, smoothstep(0.0, 1.0, gl_FragCoord.y / uRes.y));
    float a = (1.0 - exp(-body * 2.6 * thick)) * dayAmount();
    gl_FragColor = finish(over(dayPage(), material(hue, lit), a));
    return;
  }
  float density = smoothstep(0.42, 0.86, f);
  density *= density;
  vec3 col = mix(uA, uB, smoothstep(0.3, 0.8, q.y));
  col = mix(col, vec3(0.85), 0.25);
  float rise = mix(1.0, 0.45, smoothstep(0.0, 1.0, gl_FragCoord.y / uRes.y));
  gl_FragColor = finish(glow(col * density * rise * 1.1));
}
`;

/** Aurora: three curtains hung across the upper sky, each a sharp lower hem
 *  fading upward, combed into rays and shimmering — over a few stars. By day
 *  they hang in a pale blue sky, each with a bright hem and its rays fading
 *  upward, laid back to front. */
export const AURORA = /* glsl */ `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float x = uv.x * uRes.x / uRes.y;
  float t = uTime * 0.1;
  if (uLight > 0.5) {
    float k = dayAmount();
    vec3 zenith = mix(vec3(0.7, 0.8, 0.96), uB, 0.15);
    vec3 horizon = mix(vec3(1.0, 0.95, 0.9), uA, 0.06);
    vec3 col = mix(mix(dayPage(), horizon, 0.6), mix(dayPage(), zenith, 0.4), smoothstep(0.15, 1.0, uv.y));
    for (int j = 0; j < 3; j++) {
      float fi = float(2 - j);
      float curve = 0.52 + fi * 0.08
        + 0.07 * sin(x * (2.3 + fi * 0.4) + t * (1.3 + fi * 0.4) + fi * 2.1)
        + 0.04 * sin(x * (5.1 - fi) - t * 0.9 + fi)
        + 0.1 * (fbm(vec2(x * 0.9 + fi * 3.7, t * 0.7)) - 0.5);
      float dy = uv.y - curve;
      float band = dy > 0.0 ? exp(-dy * (4.0 + fi * 1.5)) : exp(dy * 40.0);
      float rays = 0.25 + 0.75 * pow(fbm(vec2(x * 20.0 + fi * 9.1, t * 1.4 + dy * 2.0)), 1.2);
      float shimmer = 0.75 + 0.25 * sin(x * 3.0 - t * 6.0 + fi);
      float comb = rays * rays;
      float veil = band * comb * shimmer * (0.9 - fi * 0.2);
      float hem = exp(-abs(dy) * 30.0);
      vec3 hue = mix(uA, uB, fi / 2.0);
      vec3 sheet = mix(material(hue, 0.5 + 0.3 * rays), mix(hue, vec3(1.0), 0.12), hem);
      col = over(col, sheet, (1.0 - exp(-veil * 3.6)) * k);
    }
    gl_FragColor = finish(col);
    return;
  }
  vec3 light = vec3(stars(gl_FragCoord.xy / uRes.y * 160.0, uTime)) * smoothstep(0.2, 0.6, uv.y) * 0.8;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float curve = 0.52 + fi * 0.08
      + 0.07 * sin(x * (2.3 + fi * 0.4) + t * (1.3 + fi * 0.4) + fi * 2.1)
      + 0.04 * sin(x * (5.1 - fi) - t * 0.9 + fi)
      + 0.1 * (fbm(vec2(x * 0.9 + fi * 3.7, t * 0.7)) - 0.5);
    float dy = uv.y - curve;
    float band = dy > 0.0 ? exp(-dy * (4.0 + fi * 1.5)) : exp(dy * 40.0);
    float rays = 0.25 + 0.75 * pow(fbm(vec2(x * 20.0 + fi * 9.1, t * 1.4 + dy * 2.0)), 1.2);
    float shimmer = 0.75 + 0.25 * sin(x * 3.0 - t * 6.0 + fi);
    light += mix(uA, uB, fi / 2.0) * band * rays * shimmer * (0.9 - fi * 0.2);
  }
  gl_FragColor = finish(glow(light * 1.4));
}
`;

/** Nebula: slowly turning gas clouds, warped twice, cut by dust lanes and
 *  brighter toward the heart, in a field of stars at two depths. By day the
 *  gas is lit like cloud, and the dust that only dims the glow at night shows
 *  as dark wisps through it. */
export const NEBULA = /* glsl */ `
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float t = uTime * 0.012;
  float c = cos(t);
  float s = sin(t);
  vec2 p = mat2(c, -s, s, c) * uv * 1.5;
  vec2 q = vec2(fbm(p + vec2(t * 2.0, 0.0)), fbm(p + vec2(3.1, 1.7) - t * 1.5));
  float cloud = fbm(p * 1.1 + 1.6 * q);
  float dust = fbm(p * 2.6 - q * 1.2 + 11.0);
  if (uLight > 0.5) {
    float k = dayAmount();
    float toward = fbm(p * 1.1 + 1.6 * q + vec2(-0.05, 0.07));
    float gas = smoothstep(0.36, 0.85, cloud);
    float lit = clamp(0.5 + (cloud - toward) * 5.0, 0.0, 1.0);
    float core = exp(-dot(uv, uv) * 2.5);
    vec3 hue = mix(uB, uA, smoothstep(0.3, 0.75, q.x));
    vec3 col = over(dayPage(), material(hue, mix(lit, 1.0, core * 0.5)), (1.0 - exp(-gas * 2.4)) * k);
    float dusty = smoothstep(0.48, 0.8, dust) * smoothstep(0.3, 0.65, cloud);
    col = over(col, mix(uB * 0.32, vec3(0.09, 0.08, 0.15), 0.45), dusty * 0.42 * k);
    gl_FragColor = finish(col);
    return;
  }
  float neb = smoothstep(0.42, 0.85, cloud);
  neb *= neb * (1.0 - 0.7 * smoothstep(0.5, 0.8, dust));
  vec3 col = mix(uB, uA, smoothstep(0.3, 0.75, q.x));
  col = mix(col, vec3(1.0, 0.97, 0.95), 0.3 * pow(neb, 2.0));
  float heart = exp(-dot(uv, uv) * 2.5);
  vec3 light = col * neb * (0.9 + 0.5 * heart) + mix(uA, uB, 0.5) * 0.05 * heart;
  float far = stars(gl_FragCoord.xy / uRes.y * 210.0, uTime);
  float near = stars(gl_FragCoord.xy / uRes.y * 90.0 + 17.0, uTime * 0.7);
  light += vec3(far * 0.8 + near * 1.2);
  gl_FragColor = finish(glow(light * 1.2));
}
`;

/** Landscape: five ridged-noise mountain ranges with atmospheric perspective,
 *  rimmed in light, mist pooling in the valleys, under a night sky with a moon
 *  and stars — or a hazy day with a low sun. Drifts very slowly. */
export const LANDSCAPE = /* glsl */ `
float ridge(float x) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 6; i++) {
    float n = 1.0 - abs(noise1(x) * 2.0 - 1.0);
    v += a * n * n;
    x *= 2.1;
    a *= 0.48;
  }
  return v;
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  float x = uv.x * aspect;
  float t = uTime * 0.015;
  float px = 0.8 / uRes.y;
  bool day = uLight > 0.5;
  vec3 page = day ? dayPage() : uBg;
  vec3 top = day ? mix(page, uB, 0.18) : page;
  vec3 horizon = mix(page, uA, day ? 0.3 : 0.45);
  vec3 col = mix(horizon, top, smoothstep(0.2, 0.95, uv.y));
  float md = length(vec2(x, uv.y) - vec2(aspect * 0.74, 0.74));
  vec3 orb = mix(uA, vec3(1.0), day ? 0.6 : 0.78);
  col += orb * (smoothstep(0.05 + px, 0.05 - px, md) * 0.85 + 0.22 * exp(-md * 7.0));
  if (!day) {
    col += vec3(stars(gl_FragCoord.xy / uRes.y * 170.0, uTime)) * smoothstep(0.45, 0.85, uv.y) * 0.9;
  }
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float depth = fi / 4.0;
    float h = 0.5 - depth * 0.11
      + (0.15 + depth * 0.08) * (ridge(x * (0.9 + depth * 1.3) + fi * 9.7 + t * (0.5 + depth)) - 0.45);
    float m = smoothstep(h + px, h - px, uv.y);
    vec3 far = mix(horizon, mix(uA, uB, 0.5), 0.25);
    vec3 near = day ? mix(page, uB, 0.45) * 0.8 : page * 0.35 + uB * 0.05;
    vec3 layer = mix(far, near, pow(depth, 0.8));
    layer += uA * smoothstep(h - 0.012, h, uv.y) * m * (1.0 - depth) * 0.35;
    col = mix(col, layer, m);
    float mist = fbm(vec2(x * 1.6 - t * (2.0 + fi), uv.y * 7.0 + fi * 3.0));
    float band = smoothstep(h - 0.03, h + 0.05, uv.y) * smoothstep(h + 0.14, h + 0.02, uv.y);
    col = mix(col, horizon, band * mist * 0.45 * (1.0 - depth * 0.6));
  }
  gl_FragColor = finish(scene(col));
}
`;

/**
 * Water: underwater, looking toward the light. Sunlight bent by the waves
 * overhead lands as caustics — a web of thin bright lines around darker
 * cells, the pattern on the floor of a pool — which slowly folds and re-forms
 * in place. The web is the edges of a Voronoi diagram whose points sway, bent
 * twice so that no edge stays straight, with a second, larger and fainter web
 * laid across it so the lines cross and brighten where they meet; brighter
 * and dimmer patches drift over it, faint shafts lean down from the surface,
 * and a few motes drift past. The water is the second colour, a clear blue
 * palette off, growing lighter toward the surface. (The first version was
 * two ridged noise fields, which read as clouds.) By day it is a sunlit pool:
 * deeper below, paler toward the surface, the web white.
 */
export const WATER = /* glsl */ `
vec2 site(vec2 id, float t) {
  vec2 h = hash22(id);
  return 0.5 + 0.36 * sin(t * (0.5 + 0.6 * h.yx) + TAU * h);
}
float edge(vec2 p, float t) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d1 = 9.0;
  float d2 = 9.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      float d = length(g + site(i + g, t) - f);
      if (d < d1) {
        d2 = d1;
        d1 = d;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }
  return d2 - d1;
}
vec2 bend(vec2 p, float t) {
  p += (vec2(noise(p * 0.6 + vec2(t * 0.11, 0.0)), noise(p * 0.6 + vec2(3.7, -t * 0.09))) - 0.5) * 1.2;
  return p + (vec2(noise(p * 1.7 + vec2(1.3, t * 0.13)), noise(p * 1.7 + vec2(-t * 0.1, 8.1))) - 0.5) * 0.4;
}
float web(vec2 p, float t, float k) {
  float e = edge(bend(p, t), t);
  return exp(-e * k) + exp(-e * 3.5) * 0.12;
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes.y;
  float h = uv.y;
  float t = uTime * 0.35;
  vec2 p = uv * 4.2;
  float a = web(p, t, 18.0);
  float b = web(mat2(0.8, -0.6, 0.6, 0.8) * p * 0.74 + 9.0, t * 0.8 + 3.0, 12.0);
  float caust = a * 0.75 + b * 0.35 + a * b * 0.9;
  caust *= 0.55 + 0.9 * noise(uv * 1.6 + vec2(uTime * 0.02, -uTime * 0.015));
  float ray = pow(noise(vec2((uv.x + (1.0 - h) * 0.3) * 5.0 + uTime * 0.03, 0.5)), 3.0) * 0.6
    + pow(noise(vec2((uv.x + (1.0 - h) * 0.2) * 11.0 - uTime * 0.02, 7.5)), 4.0) * 0.4;
  ray *= smoothstep(0.25, 1.0, h) * (0.85 + 0.15 * sin(uTime * 0.3 + uv.x * 4.0));
  if (uLight > 0.5) {
    float k = dayAmount();
    float specks = stars(uv * 80.0 + vec2(0.0, -uTime * 0.012), uTime * 0.5);
    vec3 col = mix(material(uB, 0.25), mix(uA, vec3(1.0), 0.78), 0.35 + 0.65 * smoothstep(0.0, 1.0, h));
    col = mix(dayPage(), col, clamp(0.55 + 0.35 * k, 0.0, 1.0));
    col = mix(col, vec3(1.0), clamp(caust * 0.45 * (0.5 + 0.5 * h) * k, 0.0, 0.9));
    col = mix(col, mix(uA, vec3(1.0), 0.6), clamp(ray * 0.3 * k, 0.0, 1.0));
    col = mix(col, vec3(1.0), specks * 0.5);
    gl_FragColor = finish(col);
    return;
  }
  vec3 body = uB * (0.06 + 0.26 * h * h);
  vec3 beam = mix(uA, vec3(1.0), 0.35);
  vec3 light = body + beam * caust * 0.3 * (0.45 + 0.55 * h);
  light += mix(uA, uB, 0.4) * ray * 0.2;
  float motes = stars(uv * 80.0 + vec2(0.0, -uTime * 0.012), uTime * 0.5);
  light += beam * motes * 0.18;
  gl_FragColor = finish(glow(light));
}
`;
