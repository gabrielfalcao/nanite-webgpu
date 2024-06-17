const MAT4 = 'mat4x4<f32>';

/** I always forget the order. */
export const GET_MVP_MAT = `
fn getMVP_Mat(modelMat: ${MAT4}, viewMat: ${MAT4}, projMat: ${MAT4}) -> ${MAT4} {
  let a = viewMat * modelMat;
  return projMat * a;
}
`;

/** Object-space lighting. */
export const FS_FAKE_LIGHTING = `
fn fakeLighting(wsPosition: vec4f) -> f32{
  let AMBIENT_LIGHT = 0.1;
  let LIGHT_DIR = vec3(5., 5., 5.);

  let posWsDx = dpdxFine(wsPosition);
  let posWsDy = dpdyFine(wsPosition);
  let normal = normalize(cross(posWsDy.xyz, posWsDx.xyz));
  let lightDir = normalize(LIGHT_DIR);
  let NdotL = max(0.0, dot(normal.xyz, lightDir));
  return mix(AMBIENT_LIGHT, 1.0, NdotL);
}
`;

/** Get random color based on index. Same index == same color every frame. */
export const GET_RANDOM_COLOR = `
const COLOR_COUNT = 14u;
const COLORS = array<vec3f, COLOR_COUNT>(
    vec3f(1., 1., 1.),
    vec3f(1., 0., 0.),
    vec3f(0., 1., 0.),
    vec3f(0., 0., 1.),
    vec3f(1., 1., 0.),
    vec3f(0., 1., 1.),
    vec3f(1., 0., 1.),

    vec3f(.5, .5, .5),
    vec3f(.5, 0., 0.),
    vec3f(.5, .5, 0.),
    vec3f(0., 0., .5),
    vec3f(.5, .5, 0.),
    vec3f(0., .5, .5),
    vec3f(.5, 0., .5),
);
fn getRandomColor(idx: u32) -> vec3f {
  /*let start = 2u; // color only subset, rest is default purple
  let end = start + 1u;
  if(
    idx < COLOR_COUNT * start ||
    idx > COLOR_COUNT * end
  ){
    return vec3f(.5, .2, 1.);
  }*/

  return COLORS[idx % COLOR_COUNT];
}
`;
