// The trunk's materials as the globe script draws them (threert/EarthRT app/src/materials.ts, copied for the preview's
// "before" and the terrain under the city).
import { MaterialFunction, MeshStandardMaterial } from "@threert/scene";

const HELPERS = /* wgsl */ `
fn er_hash3(p: vec3<f32>) -> f32 {
    var q = fract(p * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}
fn er_noise(p: vec3<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let a = mix(mix(er_hash3(i), er_hash3(i + vec3<f32>(1.0, 0.0, 0.0)), u.x), mix(er_hash3(i + vec3<f32>(0.0, 1.0, 0.0)), er_hash3(i + vec3<f32>(1.0, 1.0, 0.0)), u.x), u.y);
    let b = mix(mix(er_hash3(i + vec3<f32>(0.0, 0.0, 1.0)), er_hash3(i + vec3<f32>(1.0, 0.0, 1.0)), u.x), mix(er_hash3(i + vec3<f32>(0.0, 1.0, 1.0)), er_hash3(i + vec3<f32>(1.0, 1.0, 1.0)), u.x), u.y);
    return mix(a, b, u.z);
}
// A tangent basis of a normal (the terrain's uvs are data, not a parametrisation: no tangents of their own).
fn er_tangent(n: vec3<f32>) -> vec3<f32> {
    let a = select(vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(1.0, 0.0, 0.0), abs(n.z) > 0.9);
    return normalize(cross(a, n));
}
`;

/**
 * Terrain (SPEC § 4 expanded: u = water 0..1, v = class / 255). Land: the vertex colour with patches (fields, stands of
 * trees) and grain per class, fading as the ray's footprint passes their size. Water: dark and very smooth, its normal
 * waved by a few travelling sines in the tangent plane; far away the waves average into a rougher surface, so the
 * sun's glint widens as it does seen from orbit.
 */
export const TERRAIN_FN = new MaterialFunction("EarthTerrain", {
  params: { Detail: 1, WaveAmp: 1 },
  helpers: HELPERS,
  code: /* wgsl */ `
    let lp = i.wp - i.op;
    let fp = exp2(i.lod);
    let water = clamp(i.uv.x, 0.0, 1.0);
    let cls = i32(round(i.uv.y * 255.0));
    var col = o.base;
    var rough = 0.9;
    var amp = 0.22;
    var patchy = 0.0;
    if (cls == 1) { amp = 0.35; rough = 0.95; }
    else if (cls == 2 || cls == 3) { amp = 0.25; patchy = 0.25; }
    else if (cls == 4) { amp = 0.15; patchy = 0.55; rough = 0.85; }
    else if (cls == 5) { amp = 0.3; patchy = 0.3; rough = 0.8; }
    else if (cls == 6) { amp = 0.3; rough = 0.85; }
    else if (cls == 7) { amp = 0.06; rough = 0.4; }
    let k0 = 1.0 - smoothstep(20.0, 120.0, fp);
    let k1 = 1.0 - smoothstep(5.0, 30.0, fp);
    let k2 = 1.0 - smoothstep(1.2, 6.0, fp);
    // fields and blocks: cells of ~90 m, each its own tone
    let cell = er_hash3(floor(lp / 90.0)) - 0.5;
    let n1 = er_noise(lp / 40.0) - 0.5;
    let n2 = er_noise(lp / 9.0 + vec3<f32>(17.0, 3.0, 5.0)) - 0.5;
    let d = 1.0 + $Detail * (patchy * cell * k0 + amp * (n1 * 1.6 * k1 + n2 * k2));
    col = clamp(col * d, vec3<f32>(0.0), vec3<f32>(1.0));
    o.roughness = rough;
    o.specular = 0.5;
    if (water > 0.004) {
        let t = er_tangent(i.n);
        let b = cross(i.n, t);
        let x = vec2<f32>(dot(lp, t), dot(lp, b));
        // four wave trains (m, rad/s); slopes fade where the footprint outgrows them
        var g = vec2<f32>(0.0);
        let kw = (1.0 - smoothstep(4.0, 60.0, fp)) * $WaveAmp;
        var dirs = array<vec2<f32>, 4>(vec2<f32>(0.8, 0.6), vec2<f32>(-0.4, 0.92), vec2<f32>(0.97, -0.26), vec2<f32>(-0.7, -0.71));
        var lens = array<f32, 4>(23.0, 11.0, 5.3, 2.7);
        for (var k = 0; k < 4; k++) {
            let f = 6.2831853 / lens[k];
            let w = sqrt(9.81 * f);
            let ph = dot(x, dirs[k]) * f - w * i.time;
            g += dirs[k] * cos(ph) * 0.045;
        }
        let tn = normalize(vec3<f32>(-g.x * kw, -g.y * kw, 1.0));
        let nw = normalize(t * tn.x + b * tn.y + i.n * tn.z);
        o.normal = normalize(mix(o.normal, nw, water));
        o.animated = true;
        // the water itself: dark (what is seen is mostly the sky's and the sun's reflection), a hint of the tile's colour
        let deep = vec3<f32>(0.006, 0.018, 0.03) + o.base * 0.04;
        col = mix(col, deep, water);
        // the waves' slopes beyond the footprint as roughness: a wide glint from far, a sharp one close
        let rw = mix(0.025, 0.16, smoothstep(10.0, 3000.0, fp));
        o.roughness = mix(rough, rw, water);
        o.specular = mix(0.5, 0.25, water);
    }
    o.base = col;`,
});

/**
 * Buildings (SPEC § 4 expanded: walls u = metres along, v = metres above the base; roofs u, v = east, north metres).
 * Walls get windows a storey and a bay apart (glass: dark and smooth, reflecting the sky), averaged into a darker wall
 * where the footprint is larger than a window. A wall is what faces sideways (`ng.y` small: the frame's y is up near
 * the camera, where windows show).
 *
 * `Hide0` .. `Hide3`: places that replace the trunk's buildings (xyz the anchor in the frame, w the radius, m):
 * fragments within w of one (on the ground plane) are cut out (the material with `alphaTest`).
 */
export const BUILDING_FN = new MaterialFunction("EarthBuildings", {
  params: { Hide0: [0, 0, 0, 0], Hide1: [0, 0, 0, 0], Hide2: [0, 0, 0, 0], Hide3: [0, 0, 0, 0] },
  helpers: HELPERS,
  code: /* wgsl */ `
    let fp = exp2(i.lod);
    let wall = abs(i.ng.y) < 0.6;
    var col = o.base;
    o.roughness = 0.85;
    o.specular = 0.5;
    if (wall) {
        let u = i.uv.x;
        let v = i.uv.y;
        let fx = fract(u / 3.1);
        let fy = fract(v / 3.3);
        let win = step(0.22, fx) * step(fx, 0.78) * step(0.32, fy) * step(fy, 0.82) * step(1.0, v);
        let kw = 1.0 - smoothstep(0.7, 2.5, fp);
        let glass = vec3<f32>(0.035, 0.04, 0.045);
        // close: windows; far: their share of the wall darkens it
        let share = 0.3;
        col = mix(col * (1.0 - share * 0.7) + glass * share * 0.7, mix(col, glass, win), kw);
        o.roughness = mix(0.85, mix(0.85, 0.06, win), kw);
        // a slight storey line
        col *= 1.0 - 0.08 * kw * step(0.95, fy);
    } else {
        let lp = i.wp - i.op;
        col *= 1.0 + 0.12 * (er_noise(lp / 4.0) - 0.5) * (1.0 - smoothstep(1.0, 6.0, fp));
    }
    o.base = col;
    var hides = array<vec4<f32>, 4>($Hide0, $Hide1, $Hide2, $Hide3);
    for (var k = 0; k < 4; k++) {
        let h = hides[k];
        if (h.w > 0.0 && length(i.wp.xz - h.xz) < h.w) { o.opacity = 0.0; }
    }`,
});

