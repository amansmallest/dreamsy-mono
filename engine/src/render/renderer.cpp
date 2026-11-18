#include "render/renderer.h"

#include <algorithm>
#include <cstddef>

#include "base/log.h"

namespace dreamsy::render {

namespace {

// ---------------------------------------------------------------- shaders
//
// One shader for everything: position in reference px -> clip space, texture x vertex color.
// Colors and textures are premultiplied, so the blend is (ONE, ONE_MINUS_SRC_ALPHA), and
// additive quads simply have alpha 0 (geometry.h).
//
// The uniform `xform` maps reference px to clip space: clip = pos * xform.xy + xform.zw.

const char* kMetalSource = R"(
#include <metal_stdlib>
using namespace metal;

struct Params { float4 xform; };
struct VsIn {
  float2 pos [[attribute(0)]];
  float2 uv [[attribute(1)]];
  float4 color [[attribute(2)]];
};
struct VsOut {
  float4 pos [[position]];
  float2 uv;
  float4 color;
};

vertex VsOut vs_main(VsIn in [[stage_in]], constant Params& p [[buffer(0)]]) {
  VsOut out;
  out.pos = float4(in.pos * p.xform.xy + p.xform.zw, 0.0, 1.0);
  out.uv = in.uv;
  out.color = in.color;
  return out;
}

fragment float4 fs_main(VsOut in [[stage_in]], texture2d<float> tex [[texture(0)]], sampler smp [[sampler(0)]]) {
  return tex.sample(smp, in.uv) * in.color;
}
)";

const char* kGlslVertex = R"(#version 300 es
uniform vec4 xform[1];
in vec2 position;
in vec2 texcoord0;
in vec4 color0;
out vec2 uv;
out vec4 color;
void main() {
  gl_Position = vec4(position * xform[0].xy + xform[0].zw, 0.0, 1.0);
  uv = texcoord0;
  color = color0;
}
)";

const char* kGlslFragment = R"(#version 300 es
precision mediump float;
uniform sampler2D tex;
in vec2 uv;
in vec4 color;
out vec4 frag_color;
void main() {
  frag_color = texture(tex, uv) * color;
}
)";

struct Uniforms {
  float xform[4];
};

// ---- the Lighting2D pass (engine-web render/lighting.ts)
//
// One quad over the whole reference screen, drawn after the world with the blend
// frame = frame * light (src factor DST_COLOR, dst factor ZERO). Its `uv` attribute carries the
// world position of each corner, so the fragment shader gets the world point under each pixel.
// Uniform layout (kLightUniforms vec4s): [0] base rgb + light count, [1] view center xy + visible
// size, [2] vignette, [3 .. 3+64) lights (x, y, radius, falloff), [67 .. 67+64) colors (rgb * energy).
constexpr int kLightUniforms = 3 + 2 * kMaxLights;

const char* kMetalLightSource = R"(
#include <metal_stdlib>
using namespace metal;

struct Params { float4 xform; };
struct Lights { float4 u[131]; };
struct VsIn {
  float2 pos [[attribute(0)]];
  float2 uv [[attribute(1)]];
  float4 color [[attribute(2)]];
};
struct VsOut {
  float4 pos [[position]];
  float2 world;
};

vertex VsOut vs_main(VsIn in [[stage_in]], constant Params& p [[buffer(0)]]) {
  VsOut out;
  out.pos = float4(in.pos * p.xform.xy + p.xform.zw, 0.0, 1.0);
  out.world = in.uv;
  return out;
}

fragment float4 fs_main(VsOut in [[stage_in]], constant Lights& l [[buffer(0)]]) {
  float3 light = l.u[0].xyz;
  int count = int(l.u[0].w);
  for (int i = 0; i < count; i++) {
    float4 L = l.u[3 + i];
    float d = distance(in.world, L.xy);
    if (d < L.z) light += l.u[67 + i].xyz * pow(1.0 - d / L.z, L.w);
  }
  float vignette = l.u[2].x;
  if (vignette > 0.0) {
    float r = length((in.world - l.u[1].xy) / l.u[1].zw) * 1.4142 * 2.0;
    light *= 1.0 - vignette * smoothstep(0.35, 1.0, r);
  }
  return float4(min(light, float3(1.0)), 1.0);
}
)";

const char* kGlslLightVertex = R"(#version 300 es
uniform vec4 xform[1];
in vec2 position;
in vec2 texcoord0;
in vec4 color0;
out vec2 world;
void main() {
  gl_Position = vec4(position * xform[0].xy + xform[0].zw, 0.0, 1.0);
  world = texcoord0;
}
)";

const char* kGlslLightFragment = R"(#version 300 es
precision highp float;
uniform vec4 u[131];
in vec2 world;
out vec4 frag_color;
void main() {
  vec3 light = u[0].xyz;
  int count = int(u[0].w);
  for (int i = 0; i < 64; i++) {
    if (i >= count) break;
    vec4 L = u[3 + i];
    float d = distance(world, L.xy);
    if (d < L.z) light += u[67 + i].xyz * pow(1.0 - d / L.z, L.w);
  }
  float vignette = u[2].x;
  if (vignette > 0.0) {
    float r = length((world - u[1].xy) / u[1].zw) * 1.4142 * 2.0;
    light *= 1.0 - vignette * smoothstep(0.35, 1.0, r);
  }
  frag_color = vec4(min(light, vec3(1.0)), 1.0);
}
)";

struct LightUniforms {
  float u[kLightUniforms][4];
};
static_assert(kLightUniforms == 131, "the shader sources hard-code 131 vec4s (3 + 2 * kMaxLights)");

// `lighting`: the Lighting2D shader (no texture; a fragment uniform block with the lights)
// instead of the sprite shader.
sg_shader make_shader(bool lighting) {
  sg_shader_desc d{};
  const sg_backend backend = sg_query_backend();
  if (backend == SG_BACKEND_METAL_MACOS || backend == SG_BACKEND_METAL_IOS || backend == SG_BACKEND_METAL_SIMULATOR) {
    d.vertex_func.source = lighting ? kMetalLightSource : kMetalSource;
    d.vertex_func.entry = "vs_main";
    d.fragment_func.source = lighting ? kMetalLightSource : kMetalSource;
    d.fragment_func.entry = "fs_main";
  } else if (backend == SG_BACKEND_GLES3) {
    d.vertex_func.source = lighting ? kGlslLightVertex : kGlslVertex;
    d.fragment_func.source = lighting ? kGlslLightFragment : kGlslFragment;
  } else {
    log_error("render: no shader for this graphics backend (Metal and GLES3/WebGL2 only)");
    return {};
  }
  d.attrs[0].glsl_name = "position";
  d.attrs[1].glsl_name = "texcoord0";
  d.attrs[2].glsl_name = "color0";
  for (int i = 0; i < 3; i++) d.attrs[i].base_type = SG_SHADERATTRBASETYPE_FLOAT;

  d.uniform_blocks[0].stage = SG_SHADERSTAGE_VERTEX;
  d.uniform_blocks[0].size = sizeof(Uniforms);
  d.uniform_blocks[0].msl_buffer_n = 0;
  d.uniform_blocks[0].glsl_uniforms[0].glsl_name = "xform";
  d.uniform_blocks[0].glsl_uniforms[0].type = SG_UNIFORMTYPE_FLOAT4;
  d.uniform_blocks[0].glsl_uniforms[0].array_count = 1;

  if (lighting) {
    d.uniform_blocks[1].stage = SG_SHADERSTAGE_FRAGMENT;
    d.uniform_blocks[1].size = sizeof(LightUniforms);
    d.uniform_blocks[1].msl_buffer_n = 0;
    d.uniform_blocks[1].glsl_uniforms[0].glsl_name = "u";
    d.uniform_blocks[1].glsl_uniforms[0].type = SG_UNIFORMTYPE_FLOAT4;
    d.uniform_blocks[1].glsl_uniforms[0].array_count = kLightUniforms;
    d.label = "dreamsy-lighting-shader";
    return sg_make_shader(&d);
  }

  d.views[0].texture.stage = SG_SHADERSTAGE_FRAGMENT;
  d.views[0].texture.image_type = SG_IMAGETYPE_2D;
  d.views[0].texture.sample_type = SG_IMAGESAMPLETYPE_FLOAT;
  d.views[0].texture.msl_texture_n = 0;
  d.samplers[0].stage = SG_SHADERSTAGE_FRAGMENT;
  d.samplers[0].sampler_type = SG_SAMPLERTYPE_FILTERING;
  d.samplers[0].msl_sampler_n = 0;
  d.texture_sampler_pairs[0].stage = SG_SHADERSTAGE_FRAGMENT;
  d.texture_sampler_pairs[0].view_slot = 0;
  d.texture_sampler_pairs[0].sampler_slot = 0;
  d.texture_sampler_pairs[0].glsl_name = "tex";
  d.label = "dreamsy-sprite-shader";
  return sg_make_shader(&d);
}

// `offscreen`: the pixel-art target (RGBA8, no depth, 1 sample); otherwise the swapchain defaults.
// `multiply`: frame = frame * source (the lighting pass) instead of premultiplied alpha blending.
sg_pipeline make_pipeline(sg_shader shader, bool offscreen, bool multiply = false) {
  sg_pipeline_desc d{};
  d.shader = shader;
  d.layout.attrs[0].format = SG_VERTEXFORMAT_FLOAT2;  // x, y
  d.layout.attrs[1].format = SG_VERTEXFORMAT_FLOAT2;  // u, v
  d.layout.attrs[2].format = SG_VERTEXFORMAT_UBYTE4N;  // color
  d.layout.buffers[0].stride = sizeof(Vertex);
  d.index_type = SG_INDEXTYPE_UINT16;
  d.cull_mode = SG_CULLMODE_NONE;
  sg_blend_state& b = d.colors[0].blend;
  b.enabled = true;
  b.src_factor_rgb = SG_BLENDFACTOR_ONE;
  b.dst_factor_rgb = SG_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
  b.src_factor_alpha = SG_BLENDFACTOR_ONE;
  b.dst_factor_alpha = SG_BLENDFACTOR_ONE_MINUS_SRC_ALPHA;
  if (multiply) {
    b.src_factor_rgb = SG_BLENDFACTOR_DST_COLOR;
    b.dst_factor_rgb = SG_BLENDFACTOR_ZERO;
    b.src_factor_alpha = SG_BLENDFACTOR_ZERO;
    b.dst_factor_alpha = SG_BLENDFACTOR_ONE;
  }
  if (offscreen) {
    d.colors[0].pixel_format = SG_PIXELFORMAT_RGBA8;
    d.depth.pixel_format = SG_PIXELFORMAT_NONE;
    d.sample_count = 1;
  }
  d.label = multiply ? "dreamsy-lighting" : offscreen ? "dreamsy-sprites-target" : "dreamsy-sprites";
  return sg_make_pipeline(&d);
}

sg_sampler make_sampler(bool nearest) {
  sg_sampler_desc d{};
  d.min_filter = nearest ? SG_FILTER_NEAREST : SG_FILTER_LINEAR;
  d.mag_filter = nearest ? SG_FILTER_NEAREST : SG_FILTER_LINEAR;
  d.wrap_u = SG_WRAP_CLAMP_TO_EDGE;
  d.wrap_v = SG_WRAP_CLAMP_TO_EDGE;
  return sg_make_sampler(&d);
}

// A page index that means "the pixel-art target", not an atlas page.
constexpr uint16_t kTargetPage = 0xFFFF;

sg_color to_sg(Color c) { return {c.r, c.g, c.b, c.a}; }

}  // namespace

Status Renderer::init(const RenderStyle& style) {
  style_ = style;
  shader_ = make_shader(false);
  light_shader_ = make_shader(true);
  if (sg_query_shader_state(shader_) != SG_RESOURCESTATE_VALID ||
      sg_query_shader_state(light_shader_) != SG_RESOURCESTATE_VALID) {
    return Error{"render: shader failed to compile"};
  }
  pipeline_screen_ = make_pipeline(shader_, false);
  pipeline_target_ = make_pipeline(shader_, true);
  light_pipeline_screen_ = make_pipeline(light_shader_, false, true);
  light_pipeline_target_ = make_pipeline(light_shader_, true, true);
  for (sg_pipeline p : {pipeline_screen_, pipeline_target_, light_pipeline_screen_, light_pipeline_target_}) {
    if (sg_query_pipeline_state(p) != SG_RESOURCESTATE_VALID) return Error{"render: pipeline creation failed"};
  }

  // Quads share one index pattern: 0 1 2, 0 2 3 for every 4 vertices. Each batch rebases the
  // vertex buffer, so 16-bit indices are enough (geometry.h kMaxQuadsPerBatch).
  std::vector<uint16_t> idx(static_cast<size_t>(kMaxQuadsPerBatch) * 6);
  for (uint32_t q = 0; q < kMaxQuadsPerBatch; q++) {
    const auto v = static_cast<uint16_t>(q * 4);
    const uint16_t pattern[6] = {v, static_cast<uint16_t>(v + 1), static_cast<uint16_t>(v + 2),
                                 v, static_cast<uint16_t>(v + 2), static_cast<uint16_t>(v + 3)};
    std::copy(pattern, pattern + 6, idx.begin() + q * 6);
  }
  sg_buffer_desc ib{};
  ib.usage.vertex_buffer = false;
  ib.usage.index_buffer = true;
  ib.data = {idx.data(), idx.size() * sizeof(uint16_t)};
  ib.label = "dreamsy-quad-indices";
  indices_ = sg_make_buffer(&ib);

  atlas_sampler_ = make_sampler(style.nearest);
  nearest_sampler_ = make_sampler(true);
  ensure_vertex_capacity(4 * 4096);
  ready_ = true;
  return {};
}

void Renderer::shutdown() {
  if (!ready_) return;
  for (PageTexture& p : pages_) {
    sg_destroy_view(p.view);
    sg_destroy_image(p.image);
  }
  pages_.clear();
  sg_destroy_view(target_texture_);
  sg_destroy_view(target_color_);
  sg_destroy_image(target_);
  sg_destroy_buffer(vertices_);
  sg_destroy_buffer(indices_);
  sg_destroy_sampler(atlas_sampler_);
  sg_destroy_sampler(nearest_sampler_);
  sg_destroy_pipeline(pipeline_screen_);
  sg_destroy_pipeline(pipeline_target_);
  sg_destroy_pipeline(light_pipeline_screen_);
  sg_destroy_pipeline(light_pipeline_target_);
  sg_destroy_shader(shader_);
  sg_destroy_shader(light_shader_);
  ready_ = false;
}

void Renderer::ensure_vertex_capacity(size_t vertex_count) {
  if (vertex_count <= vertex_capacity_) return;
  size_t cap = std::max<size_t>(vertex_capacity_, 4096);
  while (cap < vertex_count) cap *= 2;
  if (vertices_.id != SG_INVALID_ID) sg_destroy_buffer(vertices_);
  sg_buffer_desc d{};
  d.size = cap * sizeof(Vertex);
  d.usage.vertex_buffer = true;
  d.usage.write_transient = true;  // rewritten every frame
  d.label = "dreamsy-vertices";
  vertices_ = sg_make_buffer(&d);
  vertex_capacity_ = cap;
}

void Renderer::ensure_target() {
  if (target_.id != SG_INVALID_ID) return;
  sg_image_desc d{};
  d.usage.color_attachment = true;
  d.width = style_.ref_w;
  d.height = style_.ref_h;
  d.pixel_format = SG_PIXELFORMAT_RGBA8;
  d.sample_count = 1;
  d.label = "dreamsy-pixel-target";
  target_ = sg_make_image(&d);
  sg_view_desc color{};
  color.color_attachment.image = target_;
  target_color_ = sg_make_view(&color);
  sg_view_desc tex{};
  tex.texture.image = target_;
  target_texture_ = sg_make_view(&tex);
}

// Atlas pages are immutable GPU images, re-created when their pixels change. Pages change while
// a game loads its images and first draws new text sizes, then stay put.
void Renderer::sync_pages(const Atlas& atlas) {
  stats_.page_uploads = 0;
  if (pages_.size() < atlas.page_count()) pages_.resize(atlas.page_count());
  for (size_t i = 0; i < atlas.page_count(); i++) {
    const AtlasPage& src = atlas.page(i);
    PageTexture& dst = pages_[i];
    if (dst.valid && dst.version == src.version) continue;
    if (dst.valid) {
      sg_destroy_view(dst.view);
      sg_destroy_image(dst.image);
    }
    sg_image_desc d{};
    d.width = src.width;
    d.height = src.height;
    d.pixel_format = SG_PIXELFORMAT_RGBA8;
    d.data = {src.pixels.data(), src.pixels.size()};
    d.label = "dreamsy-atlas-page";
    dst.image = sg_make_image(&d);
    sg_view_desc v{};
    v.texture.image = dst.image;
    dst.view = sg_make_view(&v);
    dst.version = src.version;
    dst.valid = true;
    stats_.page_uploads++;
  }
}

void Renderer::draw_batches(const std::vector<Batch>& batches, sg_sampler sampler, const PassArea& area) {
  bool scissored = false;
  for (const Batch& b : batches) {
    if (b.quad_count == 0) continue;
    // Clip rects are in reference px; the pass maps them to its own pixels.
    if (b.clip.enabled) {
      sg_apply_scissor_rectf(area.x + b.clip.x * area.s, area.y + b.clip.y * area.s, b.clip.w * area.s, b.clip.h * area.s,
                             true);
      scissored = true;
    } else if (scissored) {
      sg_apply_scissor_rectf(0, 0, area.w, area.h, true);  // the whole render target again
      scissored = false;
    }
    if (b.page == kTargetPage) {
      bindings_.views[0] = target_texture_;
    } else {
      if (b.page >= pages_.size() || !pages_[b.page].valid) continue;
      bindings_.views[0] = pages_[b.page].view;
    }
    bindings_.samplers[0] = sampler;
    bindings_.vertex_buffers[0] = vertices_;
    bindings_.vertex_buffer_offsets[0] = static_cast<int>(b.first_quad * 4 * sizeof(Vertex));
    bindings_.index_buffer = indices_;
    sg_apply_bindings(&bindings_);
    sg_draw(0, static_cast<int>(b.quad_count * 6), 1);
    stats_.draw_calls++;
  }
  if (scissored) sg_apply_scissor_rectf(0, 0, area.w, area.h, true);
}

// Appends the lighting quad's 4 vertices to the frame's vertex data (uploaded with everything
// else). The quad covers the reference screen; its uv carries each corner's world position.
void Renderer::push_lighting_quad(const DrawList& list) {
  const float w = static_cast<float>(style_.ref_w), h = static_cast<float>(style_.ref_h);
  const float zoom = list.camera.zoom > 0 ? list.camera.zoom : 1;
  const Vec2 cam = snapped_camera_center(list.view, list.camera, style_.pixel_snap);
  light_first_quad_ = geometry_.quad_count();
  const Vec2 corner[4] = {{0, 0}, {w, 0}, {w, h}, {0, h}};
  for (const Vec2& c : corner) {
    const Vec2 p = unproject_ground(list.view, {(c.x - w * 0.5f) / zoom + cam.x, (c.y - h * 0.5f) / zoom + cam.y});
    geometry_.vertices.push_back({c.x, c.y, p.x, p.y, 0xffffffffu});
  }
}

void Renderer::draw_lighting(const DrawList& list, bool target) {
  const Lighting& l = list.lighting;
  const float w = static_cast<float>(style_.ref_w), h = static_cast<float>(style_.ref_h);
  const float zoom = list.camera.zoom > 0 ? list.camera.zoom : 1;
  const Vec2 cam = snapped_camera_center(list.view, list.camera, style_.pixel_snap);
  LightUniforms u{};
  const int count = static_cast<int>(std::min<size_t>(l.lights.size(), kMaxLights));
  u.u[0][0] = l.base.r;
  u.u[0][1] = l.base.g;
  u.u[0][2] = l.base.b;
  u.u[0][3] = static_cast<float>(count);
  const Vec2 center = unproject_ground(list.view, cam);
  u.u[1][0] = center.x;
  u.u[1][1] = center.y;
  u.u[1][2] = std::max(1.0f, w / zoom);
  u.u[1][3] = std::max(1.0f, h / zoom);
  u.u[2][0] = l.vignette;
  for (int i = 0; i < count; i++) {
    const Light& light = l.lights[static_cast<size_t>(i)];
    float* p = u.u[3 + i];
    p[0] = light.position.x;
    p[1] = light.position.y;
    p[2] = std::max(1e-3f, light.radius);
    p[3] = light.falloff;
    float* c = u.u[3 + kMaxLights + i];
    c[0] = light.color.r;
    c[1] = light.color.g;
    c[2] = light.color.b;
  }
  const Uniforms xf{{2.0f / w, -2.0f / h, -1.0f, 1.0f}};
  sg_apply_pipeline(target ? light_pipeline_target_ : light_pipeline_screen_);
  const sg_range xf_range{&xf, sizeof xf};
  const sg_range u_range{&u, sizeof u};
  sg_apply_uniforms(0, &xf_range);
  sg_apply_uniforms(1, &u_range);
  sg_bindings b{};
  b.vertex_buffers[0] = vertices_;
  b.vertex_buffer_offsets[0] = static_cast<int>(light_first_quad_ * 4 * sizeof(Vertex));
  b.index_buffer = indices_;
  sg_apply_bindings(&b);
  sg_draw(0, 6, 1);
  stats_.draw_calls++;
}

void Renderer::draw(const DrawList& list, TextureStore& textures, FontStore& fonts, const sg_swapchain& swapchain,
                    int fb_w, int fb_h) {
  if (!ready_) return;
  stats_ = {};
  const bool pixel = style_.pixel_snap;
  fit_ = fit_rect(style_.ref_w, style_.ref_h, static_cast<float>(fb_w), static_cast<float>(fb_h));
  if (pixel) fit_ = snap_fit(fit_);

  // 1-2. Sort and batch (this also loads new images/glyphs into the atlas).
  sort_draw_list(list, sorted_);
  GeometryParams params;
  params.ref_w = style_.ref_w;
  params.ref_h = style_.ref_h;
  params.world_raster_scale = pixel ? 1.0f : fit_.s;
  params.screen_raster_scale = fit_.s;
  params.pixel_snap = pixel;
  // The UI pass covers the whole framebuffer (letterbox bars included), in reference px.
  params.screen_x0 = -fit_.x / fit_.s;
  params.screen_y0 = -fit_.y / fit_.s;
  params.screen_x1 = (static_cast<float>(fb_w) - fit_.x) / fit_.s;
  params.screen_y1 = (static_cast<float>(fb_h) - fit_.y) / fit_.s;
  build_geometry(list, sorted_, textures, fonts, params, geometry_);

  composite_.clear();
  if (pixel) {
    // The target covers the whole reference screen. GL stores render targets bottom-up, so the
    // texture is sampled upside down there.
    const float w = static_cast<float>(style_.ref_w), h = static_cast<float>(style_.ref_h);
    const Vec2 c[4] = {{0, 0}, {w, 0}, {w, h}, {0, h}};
    const UvRect uv = sg_query_features().origin_top_left ? UvRect{0, 0, 1, 1} : UvRect{0, 1, 1, 0};
    push_quad(geometry_, composite_, kTargetPage, c, uv, pack_color({1, 1, 1, 1}));
    ensure_target();
  }
  if (list.lighting.enabled) push_lighting_quad(list);
  stats_.quads = geometry_.quad_count();
  stats_.culled = geometry_.culled;

  // 3. Upload.
  sync_pages(textures.atlas());
  stats_.atlas_pages = static_cast<uint32_t>(pages_.size());
  ensure_vertex_capacity(geometry_.vertices.size());
  if (!geometry_.vertices.empty()) {
    sg_write_buffer_desc w{};
    w.src.data = {geometry_.vertices.data(), geometry_.vertices.size() * sizeof(Vertex)};
    w.dst.buffer = vertices_;
    sg_write_buffer_transient(&w);
  }

  const Uniforms u{{2.0f / static_cast<float>(style_.ref_w), -2.0f / static_cast<float>(style_.ref_h), -1.0f, 1.0f}};
  const sg_range u_range{&u, sizeof u};

  // 4a. Pixel art: the world into the reference-size target (1 texel = 1 reference px).
  const bool lit = list.lighting.enabled;
  if (pixel) {
    sg_pass pass{};
    pass.action.colors[0].load_action = SG_LOADACTION_CLEAR;
    pass.action.colors[0].clear_value = to_sg(list.clear_color);
    pass.attachments.colors[0] = target_color_;
    pass.label = "dreamsy-world-target";
    sg_begin_pass(&pass);
    const PassArea area{0, 0, static_cast<float>(style_.ref_w), static_cast<float>(style_.ref_h), 1};
    sg_apply_pipeline(pipeline_target_);
    sg_apply_uniforms(0, &u_range);
    draw_batches(geometry_.world, atlas_sampler_, area);
    if (lit) {
      draw_lighting(list, true);
      sg_apply_pipeline(pipeline_target_);
      sg_apply_uniforms(0, &u_range);
      draw_batches(geometry_.emissive, atlas_sampler_, area);
    }
    sg_end_pass();
  }

  // 4b. The window: letterbox bars, then the game rect. Scissors are in framebuffer px.
  sg_pass pass{};
  pass.action.colors[0].load_action = SG_LOADACTION_CLEAR;
  pass.action.colors[0].clear_value = to_sg(style_.letterbox_color);
  pass.swapchain = swapchain;
  pass.label = "dreamsy-screen";
  sg_begin_pass(&pass);
  const PassArea area{fit_.x, fit_.y, static_cast<float>(fb_w), static_cast<float>(fb_h), fit_.s};
  sg_apply_viewportf(fit_.x, fit_.y, fit_.w, fit_.h, true);
  sg_apply_pipeline(pipeline_screen_);
  sg_apply_uniforms(0, &u_range);
  if (pixel) {
    draw_batches(composite_, nearest_sampler_, area);
  } else {
    draw_batches(geometry_.world, atlas_sampler_, area);
    if (lit) {
      draw_lighting(list, false);
      sg_apply_pipeline(pipeline_screen_);
      sg_apply_uniforms(0, &u_range);
      draw_batches(geometry_.emissive, atlas_sampler_, area);
    }
  }
  // The UI over the whole framebuffer: reference px -> clip space through the letterbox offset,
  // so platform controls may sit in the bars (engine-web draws them in the container).
  sg_apply_viewportf(0, 0, static_cast<float>(fb_w), static_cast<float>(fb_h), true);
  const float fw = static_cast<float>(fb_w), fh = static_cast<float>(fb_h);
  const Uniforms screen_u{{2.0f * fit_.s / fw, -2.0f * fit_.s / fh, 2.0f * fit_.x / fw - 1.0f, 1.0f - 2.0f * fit_.y / fh}};
  const sg_range screen_range{&screen_u, sizeof screen_u};
  sg_apply_pipeline(pipeline_screen_);
  sg_apply_uniforms(0, &screen_range);
  draw_batches(geometry_.screen, atlas_sampler_, area);
  sg_end_pass();
}

}  // namespace dreamsy::render
