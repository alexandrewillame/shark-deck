/**
 * What every background shader starts with: the uniforms, value noise and fbm,
 * a star field, and the two ways an effect lands on the page.
 *
 * GLSL ES 1.00 (WebGL 1), for the widest reach: loops have constant bounds and
 * nothing indexes dynamically. The hashes are Dave Hoskins' sine-free ones,
 * which hold their precision across a whole window where `fract(sin(…))`
 * starts to show its grid.
 *
 * Uniforms:
 *   uRes        drawing-buffer size, px
 *   uTime       seconds of animation (frozen while still)
 *   uA, uB      the effect's two colours — the palette's accent and secondary,
 *               or its own natural pair (registry.ts)
 *   uBg         the page colour, `--bg`
 *   uLight      1 on a light page
 *   uIntensity  how strongly to draw, 0..1
 *   uPal        1 when uA/uB are the palette's, 0 for the natural pair — for
 *               what an effect has beyond its two colours: fire's white-hot
 *               core is warmer in its own colours, and the rain's city has
 *               red tail lights that a palette's two colours replace
 *
 * Helpers:
 *   lnoise1(x)   1-D value noise joined by straight lines, not curves: a
 *                zig-zag, for line work that should kink (lightning)
 *   slope(h)     how fast `h` changes across the screen, per screen height —
 *                for lighting a surface (a wet sheen). Zero where the GPU has
 *                no `OES_standard_derivatives`, which leaves the surface
 *                unlit rather than failing
 *   stars(p, t)  a sparse field of twinkling points, one maybe-star per cell
 *   glow(light)  an effect that EMITS light (smoke lit from within, fire,
 *                sparks), its colour already times how much of it there is.
 *                On a dark page light adds; on a light one it would vanish, so
 *                it is laid down as ink instead, as strongly as it was bright.
 *   scene(col)   an effect that is a PICTURE (a landscape, a painting): the
 *                whole frame, faded toward the page by the intensity
 *   finish(col)  the pixel, dithered by a fraction of a step so a slow dark
 *                gradient does not band into rings
 *
 * The GLSL itself carries no comments: a shader string is kept to plain ASCII,
 * which every WebGL implementation accepts (registry.test.ts checks).
 */
export const COMMON = /* glsl */ `
#ifdef GL_OES_standard_derivatives
#extension GL_OES_standard_derivatives : enable
#endif
precision highp float;

uniform vec2 uRes;
uniform float uTime;
uniform vec3 uA;
uniform vec3 uB;
uniform vec3 uBg;
uniform float uLight;
uniform float uIntensity;
uniform float uPal;

#define TAU 6.2831853

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
    mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}
float noise1(float x) {
  float i = floor(x);
  float f = fract(x);
  return mix(hash11(i), hash11(i + 1.0), f * f * (3.0 - 2.0 * f));
}
float lnoise1(float x) {
  float i = floor(x);
  return mix(hash11(i), hash11(i + 1.0), fract(x));
}

vec2 slope(float h) {
#ifdef GL_OES_standard_derivatives
  return vec2(dFdx(h), dFdy(h)) * uRes.y;
#else
  return vec2(0.0);
#endif
}

const mat2 ROT = mat2(1.6, 1.2, -1.2, 1.6);
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = ROT * p;
    a *= 0.5;
  }
  return v;
}
float fbm1(float x) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise1(x);
    x = x * 2.03 + 1.7;
    a *= 0.5;
  }
  return v;
}

float stars(vec2 p, float t) {
  vec2 id = floor(p);
  vec2 f = fract(p) - 0.5;
  float h = hash12(id);
  vec2 o = (hash22(id + 11.0) - 0.5) * 0.7;
  float d = length(f - o);
  float lit = smoothstep(0.955, 1.0, h);
  float twinkle = 0.55 + 0.45 * sin(t * (0.8 + h * 2.5) + h * 60.0);
  return lit * twinkle * smoothstep(0.13, 0.0, d);
}

vec3 glow(vec3 light) {
  vec3 l = max(light, 0.0) * uIntensity;
  if (uLight < 0.5) return uBg + l;
  float a = clamp(max(l.r, max(l.g, l.b)), 0.0, 1.0);
  vec3 ink = l / max(a, 0.0001);
  return mix(uBg, ink * 0.78, min(a * 1.15, 0.85));
}

vec3 scene(vec3 col) {
  return mix(uBg, col, uIntensity);
}

vec4 finish(vec3 col) {
  float n = hash12(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5;
  return vec4(col + n / 255.0, 1.0);
}
`;
