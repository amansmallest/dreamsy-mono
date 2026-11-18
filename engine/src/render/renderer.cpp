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

sg_shader make_shader() {
  sg_shader_desc d{};
  const sg_backend backend = sg_query_backend();
  if (backend == SG_BACKEND_METAL_MACOS || backend == SG_BACKEND_METAL_IOS || backend == SG_BACKEND_METAL_SIMULATOR) {
    d.vertex_func.source = kMetalSource;
    d.vertex_func.entry = "vs_main";
    d.fragment_func.source = kMetalSource;
    d.fragment_func.entry = "fs_main";
  } else if (backend == SG_BACKEND_GLES3) {
    d.vertex_func.source = kGlslVertex;
    d.fragment_func.source = kGlslFragment;
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
sg_pipeline make_pipeline(sg_shader shader, bool offscreen) {
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
  if (offscreen) {
    d.colors[0].pixel_format = SG_PIXELFORMAT_RGBA8;
    d.depth.pixel_format = SG_PIXELFORMAT_NONE;
    d.sample_count = 1;
  }
  d.label = offscreen ? "dreamsy-sprites-target" : "dreamsy-sprites";
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
  shader_ = make_shader();
  if (sg_query_shader_state(shader_) != SG_RESOURCESTATE_VALID) return Error{"render: shader failed to compile"};
  pipeline_screen_ = make_pipeline(shader_, false);
  pipeline_target_ = make_pipeline(shader_, true);
  if (sg_query_pipeline_state(pipeline_screen_) != SG_RESOURCESTATE_VALID ||
      sg_query_pipeline_state(pipeline_target_) != SG_RESOURCESTATE_VALID) {
    return Error{"render: pipeline creation failed"};
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
  sg_destroy_shader(shader_);
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

void Renderer::draw_batches(const std::vector<Batch>& batches, sg_sampler sampler) {
  for (const Batch& b : batches) {
    if (b.quad_count == 0) continue;
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

  // 4a. Pixel art: the world into the reference-size target.
  if (pixel) {
    sg_pass pass{};
    pass.action.colors[0].load_action = SG_LOADACTION_CLEAR;
    pass.action.colors[0].clear_value = to_sg(list.clear_color);
    pass.attachments.colors[0] = target_color_;
    pass.label = "dreamsy-world-target";
    sg_begin_pass(&pass);
    sg_apply_pipeline(pipeline_target_);
    sg_apply_uniforms(0, &u_range);
    draw_batches(geometry_.world, atlas_sampler_);
    sg_end_pass();
  }

  // 4b. The window: letterbox bars, then the game rect.
  sg_pass pass{};
  pass.action.colors[0].load_action = SG_LOADACTION_CLEAR;
  pass.action.colors[0].clear_value = to_sg(style_.letterbox_color);
  pass.swapchain = swapchain;
  pass.label = "dreamsy-screen";
  sg_begin_pass(&pass);
  sg_apply_viewportf(fit_.x, fit_.y, fit_.w, fit_.h, true);
  sg_apply_pipeline(pipeline_screen_);
  sg_apply_uniforms(0, &u_range);
  if (pixel) {
    draw_batches(composite_, nearest_sampler_);
  } else {
    draw_batches(geometry_.world, atlas_sampler_);
  }
  draw_batches(geometry_.screen, atlas_sampler_);
  sg_end_pass();
}

}  // namespace dreamsy::render
