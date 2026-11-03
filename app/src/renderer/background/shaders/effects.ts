/**
 * One fragment shader per background — the `main()` that follows `COMMON`.
 *
 * Every effect draws in the theme's two colours (`uA`, `uB`) over the page
 * (`uBg`), so a palette change recolours it with nothing else to do. Emitters
 * finish through `glow()`, pictures through `scene()` (see common.ts).
 */

/** Smoke: domain-warped fbm (fbm feeding fbm feeding fbm), drifting upward —
 *  heavier low down, thinning as it rises, its lit edges bleaching. */
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
  float density = smoothstep(0.42, 0.86, f);
  density *= density;
  vec3 col = mix(uA, uB, smoothstep(0.3, 0.8, q.y));
  col = mix(col, vec3(0.85), 0.25);
  float rise = mix(1.0, 0.45, smoothstep(0.0, 1.0, gl_FragCoord.y / uRes.y));
  gl_FragColor = finish(glow(col * density * rise * 1.1));
}
`;

/**
 * Fire: flames rising off the bottom edge of the window, in clusters that
 * grow and die back along it. A flame is turbulence carried upward (narrow,
 * stretched tall, swayed more the higher it gets, licked by finer noise)
 * MULTIPLIED by how far below its cluster's height it is, so only the
 * strongest turbulence reaches the top: tongues taper to points and tear off,
 * and dark gaps run between them right down to the bottom edge. Colour
 * follows how far inside a flame a point is — the second colour only at the
 * fringes and tips, the main one through the body, a pale core low down. A
 * dim, taller layer behind gives depth. Above, a faint lit haze, and a few
 * embers wandering up on their own paths, flickering — sized in pixels, so
 * they stay sparks at any window size. Unhurried: a hearth, not an
 * explosion.
 *
 * The first version added the noise to a height ramp instead, which filled
 * the whole bottom of the window with one flat sheet of the main colour
 * ringed in the second — "saturated", and all of it "concentrated at the
 * bottom of the screen".
 */
export const FIRE = /* glsl */ `
vec3 heat(float k) {
  vec3 white = mix(vec3(1.0, 0.86, 0.56), vec3(0.95, 0.98, 1.0), uPal);
  vec3 c = mix(uB * 0.6, uB, smoothstep(0.0, 0.12, k));
  c = mix(c, uA, smoothstep(0.12, 0.45, k));
  return mix(c, white, smoothstep(0.75, 1.0, k) * 0.5);
}
float fbm3(vec2 p) {
  return noise(p) * 0.57 + noise(ROT * p) * 0.29 + noise(ROT * ROT * p) * 0.14;
}
float embers(vec2 p, float t, float px) {
  float acc = 0.0;
  for (int i = 0; i < 2; i++) {
    float fi = float(i);
    float cell = 0.085 - fi * 0.025;
    vec2 g = vec2(p.x / cell + fi * 7.3, (p.y - t * (0.06 + fi * 0.03)) / cell);
    vec2 id = floor(g);
    float h = hash12(id + fi * 19.0);
    float ph = h * 40.0;
    vec2 c = (hash22(id + 4.0) - 0.5) * 0.3 + vec2(0.18 * sin(t * (0.6 + h) + ph), 0.0);
    vec2 d = (fract(g) - 0.5 - c) * cell * vec2(1.0, 0.45);
    float r = length(d);
    float flick = 0.4 + 0.6 * pow(0.5 + 0.5 * sin(t * (2.5 + 4.0 * h) + ph), 2.0);
    float size = (1.1 + 1.4 * hash12(id + 2.0)) * px;
    acc += step(0.9, h) * flick * (smoothstep(size, size * 0.3, r) + 0.3 * exp(-r / (4.0 * px)));
  }
  return acc;
}
void main() {
  vec2 p = gl_FragCoord.xy / uRes.y;
  float px = 1.0 / uRes.y;
  float t = uTime;
  float y = p.y + 0.03;
  float feed = fbm3(vec2(p.x * 0.7 + 3.0, t * 0.03));
  float sway = (fbm3(vec2(p.x * 1.2 - t * 0.04, y * 1.3 - t * 0.2)) - 0.5) * 0.5 * y;
  float xs = p.x + sway;
  float bed = smoothstep(0.25, 0.75, fbm3(vec2(xs * 1.8 + 5.0, t * 0.05)));
  float tall = (0.25 + 0.25 * smoothstep(0.3, 0.72, feed)) * (0.7 + 0.5 * bed);
  vec2 q = vec2(xs * 7.5, y * 2.4 - t * 0.55);
  q.x += (noise(q * vec2(1.3, 2.2) + vec2(0.0, -t * 0.5)) - 0.5) * 0.7;
  float n = fbm(q) * 0.66 + fbm(q * vec2(2.5, 2.0) + vec2(1.7, -t * 0.8)) * 0.26
    + noise(q * vec2(6.0, 4.0) + vec2(3.1, -t * 1.3)) * 0.08;
  float shape = clamp(1.0 - y / tall, 0.0, 1.0);
  float v = max(n - 0.3, 0.0) * 2.2 * pow(shape, 0.8) * (0.64 + 0.44 * bed);
  float temp = clamp((v - 0.12) * 1.6, 0.0, 1.0);
  float lum = smoothstep(0.12, 0.15, v) * (0.12 + 0.88 * pow(temp, 1.2));
  vec3 light = heat(temp) * lum * 1.1;
  vec2 qb = vec2(xs * 4.0 + 11.0, y * 1.8 - t * 0.4);
  float vb = max(fbm(qb) - 0.3, 0.0) * 2.0 * pow(clamp(1.0 - y / (tall * 1.3 + 0.05), 0.0, 1.0), 0.8);
  light += heat(0.1 + 0.3 * vb) * smoothstep(0.08, 0.35, vb) * 0.06 * (1.0 - lum);
  light += mix(uB, uA, 0.4) * (0.015 + 0.05 * bed) * exp(-y * 3.0);
  float smoke = fbm3(vec2(xs * 1.4, y * 1.2 - t * 0.07));
  light += uB * smoke * smoothstep(tall * 0.6, tall * 1.4, y) * smoothstep(0.95, 0.35, y) * 0.03;
  float life = smoothstep(tall * 0.5, tall * 1.05, y) * smoothstep(0.75, 0.3, y);
  light += mix(uA, vec3(1.0, 0.86, 0.55), 0.55) * embers(p, t, px) * life * 1.2;
  gl_FragColor = finish(glow(light));
}
`;

/**
 * Electricity: a thunderstorm at night, mostly waiting. A low ceiling of storm
 * cloud hangs over the upper sky, drifting slowly sideways and churning in
 * place: heavy, lumpy masses whose undersides catch a faint light from below
 * (each lump is lit where its density falls away beneath it), so they read as
 * cloud — the first versions had a fast-moving glow of filaments here, and
 * "what is this smoke?" was the fair question. Rain falls through it all,
 * barely there until a flash lights it. About every three or four seconds,
 * unevenly — two slow, independent clocks, each of which often lets its turn
 * pass — a burst strikes out of the clouds: one bolt, then often a second and
 * sometimes a third a moment later, each in its own place. Several at once is
 * what a storm looks like; a bolt every second was what made the first
 * version tiring. A bolt is a line kinked at every scale (straight-line noise,
 * not smooth: lightning zig-zags, it does not wave), with forks splitting off
 * it, a hard core a couple of pixels wide in a soft glow, and the quick
 * re-strokes and decay of a real flash, which lights up the clouds around it.
 * In between, lightning hidden in the clouds now and then lights a patch of
 * them from within.
 */
export const ELECTRICITY = /* glsl */ `
float jag(float y, float s) {
  return (lnoise1(y * 4.0 + s) - 0.5) * 0.22
    + (lnoise1(y * 11.0 + s * 1.7) - 0.5) * 0.09
    + (lnoise1(y * 29.0 + s * 2.3) - 0.5) * 0.035
    + (lnoise1(y * 77.0 + s * 3.1) - 0.5) * 0.012;
}
float boltX(float seed, float aspect) {
  return (0.08 + 0.84 * hash11(seed + 2.1)) * aspect;
}
vec3 bolt(vec2 q, float tau, float seed, float aspect, float px, out float env) {
  env = 0.0;
  if (tau < 0.0 || tau > 0.8) return vec3(0.0);
  env = exp(-tau * 7.0);
  env += 0.8 * step(0.07, tau) * exp(-(tau - 0.07) * 10.0);
  env += 0.45 * step(0.2, tau) * exp(-(tau - 0.2) * 9.0);
  env *= 0.82 + 0.18 * sin(tau * 140.0 + seed);
  float x0 = boltX(seed, aspect);
  float yEnd = 0.06 + 0.42 * hash11(seed + 3.7);
  float lean = (hash11(seed + 4.9) - 0.5) * 0.5;
  float y = q.y;
  float x = x0 + (1.05 - y) * lean + jag(y, seed);
  float d = abs(q.x - x);
  float on = smoothstep(yEnd - 0.01, yEnd + 0.1, y);
  float core = smoothstep(2.4 * px, 0.6 * px, d) * on;
  float halo = (0.004 / (d + 0.004) * 0.5 + exp(-d * 10.0) * 0.16) * on;
  for (int b = 0; b < 3; b++) {
    float bs = seed + 11.0 + float(b) * 5.3;
    float y0 = mix(yEnd + 0.1, 0.9, hash11(bs));
    float len = 0.07 + 0.2 * hash11(bs + 1.0);
    float side = hash11(bs + 2.0) < 0.5 ? -1.0 : 1.0;
    float xb = x0 + (1.05 - y0) * lean + jag(y0, seed)
      + (y0 - y) * side * (0.25 + 0.45 * hash11(bs + 3.0))
      + (jag(y, bs) - jag(y0, bs)) * 0.6;
    float db = abs(q.x - xb);
    float span = step(y, y0) * smoothstep(y0 - len, y0 - len * 0.35, y);
    core += smoothstep(1.6 * px, 0.3 * px, db) * span * 0.75;
    halo += 0.0025 / (db + 0.003) * 0.32 * span;
  }
  vec3 hot = mix(uA, vec3(1.0), 0.62);
  return (hot * core * 1.5 + uA * halo) * env;
}
vec3 burst(vec2 q, float t, float period, float lane, float aspect, float px, out float flash, out float sx) {
  flash = 0.0;
  sx = -10.0;
  vec3 light = vec3(0.0);
  float k = t / period + lane * 0.43;
  for (int s = 0; s < 2; s++) {
    float slot = floor(k) - float(s);
    float seed = slot * 7.31 + lane * 19.7 + 3.0;
    if (hash11(seed + 0.5) < 0.45) continue;
    float since = (k - slot - 0.15 - 0.55 * hash11(seed + 1.3)) * period;
    if (since < 0.0 || since > 1.6) continue;
    float delay = 0.0;
    for (int j = 0; j < 3; j++) {
      float fj = float(j);
      float bs = seed + fj * 13.7;
      if (j > 0) {
        if (hash11(bs + 8.3) < 0.25 * fj) break;
        delay += 0.06 + 0.3 * hash11(bs + 6.1);
      }
      float env;
      light += bolt(q, since - delay, bs, aspect, px, env);
      if (env > flash) {
        flash = env;
        sx = boltX(bs, aspect);
      }
    }
  }
  return light;
}
float sheet(vec2 q, float t, float aspect) {
  float k = t / 2.3;
  float seed = floor(k) * 5.77 + 41.0;
  if (hash11(seed) < 0.55) return 0.0;
  float tau = (fract(k) - 0.2 * hash11(seed + 1.1)) * 2.3;
  if (tau < 0.0 || tau > 0.9) return 0.0;
  float env = exp(-tau * 5.0) * (0.7 + 0.3 * sin(tau * 60.0 + seed));
  env += 0.6 * step(0.12, tau) * exp(-(tau - 0.12) * 7.0);
  vec2 c = vec2((0.1 + 0.8 * hash11(seed + 2.7)) * aspect, 0.62 + 0.3 * hash11(seed + 3.9));
  return env * exp(-length((q - c) * vec2(0.8, 1.4)) * 3.2);
}
float rain(vec2 q, float t) {
  vec2 p = vec2(q.x * 110.0 + q.y * 16.0, q.y * 2.2 + t * 1.15);
  float col = floor(p.x);
  float h = hash11(col * 1.37 + 0.5);
  float y = fract(p.y + h * 7.0);
  float dash = smoothstep(0.0, 0.05, y) * smoothstep(0.32, 0.06, y);
  float line = smoothstep(0.5, 0.15, abs(fract(p.x) - 0.5));
  return dash * line * step(0.62, h);
}
float cloudF(vec2 p, vec2 w, float y) {
  return fbm(p * 1.3 + w) * 0.7 + fbm(p * 3.4 + w * 0.6 + 7.0) * 0.3
    + fbm(p * 8.5 + w * 0.3 + 13.0) * 0.13 + (y - 0.5) * 0.85;
}
void main() {
  vec2 q = gl_FragCoord.xy / uRes.y;
  float aspect = uRes.x / uRes.y;
  float px = 1.0 / uRes.y;
  float t = uTime;
  float drift = t * 0.008;
  vec2 cq = vec2(q.x * 0.55 + drift, q.y * 1.25);
  vec2 w = vec2(fbm(cq * 0.9 + vec2(0.0, t * 0.01)), fbm(cq * 0.9 + vec2(5.2, 1.3) - t * 0.01)) - 0.5;
  float f = cloudF(cq, w, q.y);
  float fb = cloudF(cq - vec2(0.0, 0.025), w, q.y - 0.02);
  float dens = smoothstep(0.48, 0.78, f);
  float under = clamp((dens - smoothstep(0.48, 0.78, fb)) * 3.5, 0.0, 1.0);
  vec2 lq = cq * 2.6 + w * 0.8 + vec2(3.0, -drift * 1.5);
  float lump = clamp((fbm(lq) - fbm(lq - vec2(0.0, 0.08))) * 9.0, 0.0, 1.0);
  float thick = smoothstep(0.62, 1.05, f);
  vec3 sky = mix(uB, uA, 0.25);
  vec3 cloudCol = mix(sky, vec3(0.62, 0.66, 0.76), 0.45);
  vec3 light = sky * 0.03 * (1.0 - q.y);
  light = mix(light, cloudCol * (0.045 + 0.03 * thick + 0.12 * lump), dens);
  light += cloudCol * under * 0.18;
  float f0;
  float s0;
  float f1;
  float s1;
  light += burst(q, t, 3.3, 0.0, aspect, px, f0, s0);
  light += burst(q, t, 4.7, 1.0, aspect, px, f1, s1);
  float glowIn = sheet(q, t, aspect);
  float lit = f0 * exp(-abs(q.x - s0) * 1.5) + f1 * exp(-abs(q.x - s1) * 1.5);
  vec3 flashCol = mix(uA, vec3(0.85, 0.9, 1.0), 0.45);
  light += flashCol * (dens * (0.3 + 0.25 * thick + 0.4 * lump) + under * 0.6 + 0.04) * lit * 0.6;
  light += flashCol * (dens * (0.45 + 0.3 * thick + 0.4 * lump) + under * 0.3) * glowIn * 0.35;
  light += mix(sky, vec3(0.8, 0.85, 0.95), 0.5) * rain(q, t) * (1.0 - dens * 0.7) * (0.04 + 0.5 * min(lit + glowIn, 1.0));
  gl_FragColor = finish(glow(light));
}
`;

/**
 * Lava: a lava lake. Cooled crust is broken into plates drifting on the melt,
 * parted by glowing cracks that widen where the melt runs hot; elsewhere the
 * melt breaks through in open pools, streaked with flow and carrying islands
 * of dark skin. The plates are cells of a field bent at two scales before the
 * cells are cut, and their seams are roughened and vary in width — unbent,
 * every seam was a straight line and every junction a sharp polygon corner,
 * which read as tiles rather than rock. The crust is lit faintly from above,
 * glows where it borders the heat and is crazed with hairline cracks near the
 * pools, and the heat breathes.
 */
export const LAVA = /* glsl */ `
vec3 heat(float k) {
  vec3 white = mix(vec3(1.0, 0.82, 0.4), vec3(1.0), uPal * 0.6);
  vec3 c = mix(uB * 0.4, uB, smoothstep(0.0, 0.3, k));
  c = mix(c, uA, smoothstep(0.25, 0.6, k));
  return mix(c, white, smoothstep(0.7, 1.0, k) * 0.55);
}
float cracks(vec2 p) {
  return abs(fbm(p) * 2.0 - 1.0);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes.y;
  float t = uTime * 0.03;
  vec2 p = uv * 2.6;
  vec2 w = vec2(fbm(p * 0.4 + vec2(0.0, t)), fbm(p * 0.4 + vec2(4.7, 1.3) - t)) - 0.5;
  vec2 cp = p + vec2(t * 1.1, t * 0.35) + w * 1.2;
  float pid = noise(cp * 0.45 + 7.0);
  float melt = fbm(uv * 1.9 + vec2(-t * 0.9, t * 0.55) + w * 0.9 + 9.0);
  float lip = (fbm(cp * 4.0 + 3.0) - 0.5) * 0.06;
  float pool = smoothstep(0.565, 0.585, melt + lip);
  float width = (0.016 + 0.11 * smoothstep(0.44, 0.585, melt)) * (0.65 + 0.7 * noise(cp * 2.3 + 5.0));
  float e = cracks(cp * 0.8 + 31.0) * 1.1 + lip + (noise(cp * 13.0) - 0.5) * 0.022;
  float crack = smoothstep(width, width * 0.72 - 0.003, e);
  float molten = max(pool, crack);
  float depth = max(clamp(1.0 - e / width, 0.0, 1.0) * crack, smoothstep(0.57, 0.7, melt));
  float flow = fbm(vec2(cp.x * 1.6 - uTime * 0.05, cp.y * 4.5 + sin(cp.x * 1.3)) + pid * 5.0);
  float skin = smoothstep(0.56, 0.62, fbm(cp * 2.4 - vec2(uTime * 0.03, 0.0) + 21.0)) * pool;
  float pulse = 0.85 + 0.15 * sin(uTime * 0.45 + pid * TAU + melt * 6.0);
  float temp = molten * (0.45 + 0.55 * sqrt(depth)) * (0.5 + 0.7 * flow) * (1.0 - 0.75 * skin) * pulse;
  float crust = 1.0 - molten;
  float hair = smoothstep(0.03, 0.0, cracks(cp * 2.4 + 13.0) * 1.2) * crust * smoothstep(0.38, 0.56, melt);
  float rock = fbm(cp * 4.0 + pid * 17.0) * 0.65 + noise(cp * 26.0) * 0.35;
  vec3 n = normalize(vec3(-slope(rock) * 0.015, 1.0));
  float sun = clamp(dot(n, normalize(vec3(-0.5, 0.6, 0.65))), 0.0, 1.0);
  float rim = max(exp(-max(e - width, 0.0) * 52.0), smoothstep(0.5, 0.565, melt)) * crust;
  vec3 light = heat(temp) * temp * 1.1;
  light += uB * rim * (0.2 + 0.1 * pulse);
  light += heat(0.3) * hair * 0.3 * pulse;
  vec3 stone = mix(vec3(0.5, 0.46, 0.44), uB, 0.35);
  light += stone * crust * (0.03 + 0.13 * rock * sun);
  gl_FragColor = finish(glow(light));
}
`;

/** Aurora: three curtains hung across the upper sky, each a sharp lower hem
 *  fading upward, combed into rays and shimmering — over a few stars. */
export const AURORA = /* glsl */ `
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float x = uv.x * uRes.x / uRes.y;
  float t = uTime * 0.1;
  vec3 light = vec3(stars(gl_FragCoord.xy / uRes.y * 160.0, uTime))
    * (1.0 - uLight) * smoothstep(0.2, 0.6, uv.y) * 0.8;
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
 *  brighter toward the heart, in a field of stars at two depths. */
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
  float neb = smoothstep(0.42, 0.85, cloud);
  neb *= neb * (1.0 - 0.7 * smoothstep(0.5, 0.8, dust));
  vec3 col = mix(uB, uA, smoothstep(0.3, 0.75, q.x));
  col = mix(col, vec3(1.0, 0.97, 0.95), 0.3 * pow(neb, 2.0));
  float heart = exp(-dot(uv, uv) * 2.5);
  vec3 light = col * neb * (0.9 + 0.5 * heart) + mix(uA, uB, 0.5) * 0.05 * heart;
  float far = stars(gl_FragCoord.xy / uRes.y * 210.0, uTime);
  float near = stars(gl_FragCoord.xy / uRes.y * 90.0 + 17.0, uTime * 0.7);
  light += vec3(far * 0.8 + near * 1.2) * (1.0 - uLight);
  gl_FragColor = finish(glow(light * 1.2));
}
`;

/** Landscape: five ridged-noise mountain ranges with atmospheric perspective,
 *  rimmed in light, mist pooling in the valleys; a night sky with a moon and
 *  stars, or a hazy day with a low sun on a light page. Drifts very slowly. */
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
  vec3 top = day ? mix(uBg, uB, 0.18) : uBg;
  vec3 horizon = mix(uBg, uA, day ? 0.3 : 0.45);
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
    vec3 near = day ? mix(uBg, uB, 0.45) * 0.8 : uBg * 0.35 + uB * 0.05;
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
 * two ridged noise fields, which read as clouds.)
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
  vec3 body = uB * (0.06 + 0.26 * h * h);
  vec3 beam = mix(uA, vec3(1.0), 0.35);
  vec3 light = body + beam * caust * 0.3 * (0.45 + 0.55 * h);
  light += mix(uA, uB, 0.4) * ray * 0.2;
  float motes = stars(uv * 80.0 + vec2(0.0, -uTime * 0.012), uTime * 0.5);
  light += beam * motes * 0.18;
  gl_FragColor = finish(glow(light));
}
`;

/**
 * Rain: a window on a rainy night. Behind the glass, a city's lights out of
 * focus — soft discs of light (bokeh), each with the slightly brighter rim a
 * real lens gives them, at three depths, thickest along the lower part of the
 * frame where the street would be, a few drifting like distant traffic. On
 * the glass, beads of rain at two sizes, each one a tiny lens: it shows a
 * wide patch of the lights behind it, upside down and in focus (points, not
 * discs), with a dark edge, a lit lower rim and a glint. Beads land, shrink
 * as they dry and are gone. Now and then a drop runs down the pane in fits
 * and starts — it rests, then slides — wandering a little, and leaves a clear
 * trail through the faint mist on the glass, with a line of small droplets
 * left behind in it that dry up after it. Palette off, the lights are a
 * city's own: sodium amber and a cool white-blue, with the odd red tail light
 * and warm white (`uPal`); palette on, they are the palette's two colours.
 */
export const RAIN = /* glsl */ `
vec3 lampCol(float k) {
  vec3 c = k < 0.5 ? uA : uB;
  vec3 own = k < 0.06 ? vec3(1.0, 0.3, 0.22) : (k > 0.92 ? vec3(1.0, 0.93, 0.82) : c);
  return mix(own, mix(c, vec3(1.0), 0.2 * step(0.88, k)), uPal);
}
void lamps(vec2 uv, float scale, float seed, float t, float drift, float gain, inout vec3 soft, inout vec3 sharp) {
  vec2 p = uv * scale + vec2(t * drift * scale, 0.0);
  vec2 id = floor(p);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 c = id + vec2(float(x), float(y));
      float h = hash12(c + seed);
      if (h < 0.55) continue;
      vec2 o = hash22(c + seed + 3.1);
      float r = 0.3 + 0.42 * hash12(c + seed + 7.7);
      float d = length(p - c - o) / r;
      if (d > 1.0) continue;
      float yy = (c.y + o.y) / scale;
      float band = 0.15 + 0.85 * smoothstep(0.85, 0.35, yy) * smoothstep(-0.2, 0.15, yy);
      float k = hash12(c + seed + 13.3);
      float tw = 0.85 + 0.15 * sin(t * (0.2 + 0.5 * k) + k * 50.0);
      float lum = fract(h * 7.3);
      vec3 lc = lampCol(k) * tw * band * (0.15 + 0.85 * lum * lum) * gain;
      soft += lc * smoothstep(1.0, 0.9, d) * (0.65 + 0.35 * smoothstep(0.5, 0.95, d));
      sharp += lc * smoothstep(0.3, 0.08, d) * 1.6;
    }
  }
}
void backdrop(vec2 uv, float t, out vec3 soft, out vec3 sharp) {
  soft = mix(uA, uB, 0.35) * 0.035 * smoothstep(0.9, 0.0, uv.y);
  sharp = vec3(0.0);
  lamps(uv, 9.0, 1.0, t, 0.0, 0.17, soft, sharp);
  lamps(uv, 5.0, 17.0, t, 0.006, 0.22, soft, sharp);
  lamps(uv, 2.8, 31.0, t, -0.004, 0.15, soft, sharp);
}
vec4 bead(vec2 uv, float scale, float seed, float t) {
  vec2 p = uv * scale;
  vec2 id = floor(p);
  vec2 f = fract(p) - 0.5;
  float h = hash12(id + seed);
  vec2 o = (hash22(id + seed + 1.7) - 0.5) * 0.4;
  float life = fract(t * (0.008 + 0.017 * fract(h * 5.7)) + h * 13.0);
  float r = (0.1 + 0.18 * fract(h * 17.1)) * (1.0 - 0.5 * life) * smoothstep(0.0, 0.006, life) * smoothstep(1.0, 0.94, life);
  vec2 d = (f - o) / max(r, 0.001);
  vec2 n = d / max(length(d), 0.0001);
  float a = h * 40.0;
  float b = h * 17.0;
  float wob = 1.0
    + 0.09 * (n.x * (4.0 * n.x * n.x - 3.0) * cos(a) - n.y * (3.0 - 4.0 * n.y * n.y) * sin(a))
    + 0.05 * ((n.x * n.x - n.y * n.y) * cos(b) - 2.0 * n.x * n.y * sin(b));
  float m = smoothstep(1.0, 0.8, length(d) * wob) * step(0.45, h) * step(0.001, r);
  return vec4(d, m, r / scale);
}
float pathX(float y, float x0, float s) {
  return x0 + 0.004 * sin(y * 23.0 + s * 40.0) + 0.0025 * sin(y * 57.0 + s * 17.0);
}
vec4 runner(vec2 uv, float colW, float seed, float t, out float trail, out vec4 bit) {
  float cx = floor(uv.x / colW);
  float h = hash11(cx * 1.37 + seed);
  float speed = 0.05 + 0.06 * hash11(cx * 2.11 + seed + 4.0);
  float period = 1.5 / speed + 4.0 + 8.0 * hash11(cx + seed + 9.0);
  float tt = t + h * 100.0;
  float cyc = floor(tt / period);
  float tau = tt - cyc * period;
  float s = hash11(cyc * 3.71 + cx * 1.13 + seed);
  float on = step(colW < 0.15 ? 0.6 : 0.35, s);
  float x0 = (cx + 0.2 + 0.6 * hash11(cyc * 5.3 + cx * 2.9 + seed + 2.0)) * colW;
  float hop = 0.9 + 1.6 * s;
  float y = 1.15 - speed * hop * (floor(tau / hop) + smoothstep(0.0, 0.5, fract(tau / hop)));
  float rr = (colW < 0.15 ? 0.013 : 0.02) + 0.009 * s;
  vec2 d = (uv - vec2(pathX(y, x0, s), y)) / rr;
  d.y *= 0.85;
  d.x *= 1.0 + 0.5 * clamp(d.y, 0.0, 1.5);
  float m = smoothstep(1.0, 0.75, length(d)) * on;
  float above = uv.y - y;
  float len = 0.3 + 0.3 * s;
  float tw = rr * 0.75;
  trail = on * step(0.0, above) * smoothstep(len, 0.0, above) * smoothstep(tw, tw * 0.3, abs(uv.x - pathX(uv.y, x0, s)));
  float sp = 0.03;
  float cy = floor(uv.y / sp);
  float hd = hash11(cy * 7.7 + cx * 3.3 + cyc * 1.9 + seed);
  float yc = (cy + 0.5) * sp;
  vec2 dc = vec2(pathX(yc, x0, s) + (hd - 0.5) * rr * 0.8, yc);
  float age = yc - y;
  float rd = rr * (0.25 + 0.3 * hd) * smoothstep(len, len * 0.2, age) * step(rr * 1.5, age) * step(0.3, hd);
  vec2 dd = (uv - dc) / max(rd, 0.0001);
  bit = vec4(dd, smoothstep(1.0, 0.75, length(dd)) * on * step(0.0001, rd), rd);
  return vec4(d, m, rr);
}
void lens(vec4 v, float reach, inout vec2 off, inout float m, inout float ring, inout float spec, inout float lo) {
  float l = length(v.xy);
  off = mix(off, -v.xy * (v.w + reach), v.z);
  ring = mix(ring, smoothstep(0.5, 1.0, l), v.z);
  spec = mix(spec, smoothstep(0.32, 0.0, length(v.xy - vec2(-0.3, 0.42))), v.z);
  lo = mix(lo, smoothstep(0.55, 0.95, l) * smoothstep(0.1, -0.7, v.y), v.z);
  m = max(m, v.z);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes.y;
  float t = uTime;
  float tr1;
  float tr2;
  vec4 bit1;
  vec4 bit2;
  vec4 r1 = runner(uv, 0.19, 1.0, t, tr1, bit1);
  vec4 r2 = runner(uv, 0.11, 7.0, t * 0.9, tr2, bit2);
  float trail = max(tr1, tr2);
  vec4 b1 = bead(uv, 10.0, 3.0, t);
  vec4 b2 = bead(uv, 20.0, 11.0, t);
  b1.z *= 1.0 - trail;
  b2.z *= 1.0 - trail;
  vec2 off = vec2(0.0);
  float m = 0.0;
  float ring = 0.0;
  float spec = 0.0;
  float lo = 0.0;
  lens(b2, 0.12, off, m, ring, spec, lo);
  lens(b1, 0.18, off, m, ring, spec, lo);
  lens(bit2, 0.12, off, m, ring, spec, lo);
  lens(bit1, 0.12, off, m, ring, spec, lo);
  lens(r2, 0.28, off, m, ring, spec, lo);
  lens(r1, 0.34, off, m, ring, spec, lo);
  vec3 soft;
  vec3 sharp;
  backdrop(uv + off, t, soft, sharp);
  vec3 tint = mix(uA, uB, 0.5);
  float fog = 1.0 - trail;
  vec3 sheen = mix(tint, vec3(0.8), 0.5);
  vec3 glass = mix(soft * 0.85, soft + tint * 0.03 + soft * 0.12, fog);
  glass += sheen * trail * (1.0 - trail) * 0.14;
  vec3 drop = soft * 0.8 + sheen * 0.03 + sharp;
  vec3 col = mix(glass, drop, m);
  col *= 1.0 - ring * m * 0.25;
  col += sheen * lo * m * 0.14;
  col += mix(vec3(1.0), uA, 0.25) * spec * m * 0.4;
  gl_FragColor = finish(glow(col));
}
`;
