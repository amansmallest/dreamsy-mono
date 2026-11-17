// dreamsy-tool: the headless command-line engine.
//
//   dreamsy-tool version
//   dreamsy-tool validate <package> [--json]   check a package; exit 1 on errors
//   dreamsy-tool info <package>                summary + content hash
//   dreamsy-tool pack <package> <out.dpk>      validate, then write a Dreamsy pack
//   dreamsy-tool unpack <pack.dpk> <dir>       extract a pack into a directory
//   dreamsy-tool run <package> [--ticks N] [--seed S] [--budget MS]   run scripts headless
//   dreamsy-tool smoke [--seed N] [--bodies N] [--steps N]
//
// <package> is a directory, a .dpk pack, or a legacy .zip (converted on the fly).
// Later slices add: run, playtest, replay, hash, screenshot (DREAMSY.MD §14.3).
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <string_view>

#include "base/log.h"
#include "base/version.h"
#include "dev/smoke.h"
#include "pkg/json.h"
#include "pkg/text.h"
#include "pkg/validate.h"
#include "pkg/zip_import.h"
#include "script/host.h"

using namespace dreamsy;
namespace fs = std::filesystem;

namespace {

int usage() {
  std::fprintf(stderr,
               "usage:\n"
               "  dreamsy-tool version\n"
               "  dreamsy-tool validate <package> [--json]\n"
               "  dreamsy-tool info <package>\n"
               "  dreamsy-tool pack <package> <out.dpk>\n"
               "  dreamsy-tool unpack <pack.dpk> <dir>\n"
               "  dreamsy-tool run <package> [--ticks N] [--seed S] [--budget MS]\n"
               "  dreamsy-tool smoke [--seed N] [--bodies N] [--steps N]\n"
               "<package> is a directory, a .dpk pack or a .zip\n");
  return 2;
}

Result<std::shared_ptr<pkg::Files::Bytes>> read_file(const std::string& path) {
  std::ifstream in(path, std::ios::binary | std::ios::ate);
  if (!in) return Error{"cannot open " + path};
  auto size = static_cast<size_t>(in.tellg());
  auto bytes = std::make_shared<pkg::Files::Bytes>(size);
  in.seekg(0);
  if (!in.read(reinterpret_cast<char*>(bytes->data()), static_cast<std::streamsize>(size))) {
    return Error{"cannot read " + path};
  }
  return bytes;
}

Result<pkg::Files> load_files(const std::string& path) {
  std::error_code ec;
  if (fs::is_directory(path, ec)) return pkg::Files::from_dir(path);
  auto bytes = read_file(path);
  if (!bytes) return Error{bytes.error()};
  if (pkg::ends_with(path, ".zip")) return pkg::import_zip(*bytes.value());
  return pkg::Files::from_pack(std::move(bytes).value());
}

Status write_file(const std::string& path, std::span<const uint8_t> data) {
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  if (!out || !out.write(reinterpret_cast<const char*>(data.data()), static_cast<std::streamsize>(data.size()))) {
    return Error{"cannot write " + path};
  }
  return Status::success();
}

void print_issues(const std::vector<pkg::Issue>& issues) {
  for (const pkg::Issue& i : issues) std::fprintf(stderr, "%s\n", pkg::format_issue(i).c_str());
}

std::string issues_json(const pkg::LoadResult& r) {
  std::string out = "{\"ok\":" + std::string(r.ok ? "true" : "false") + ",\"issues\":[";
  for (size_t k = 0; k < r.issues.size(); ++k) {
    const pkg::Issue& i = r.issues[k];
    if (k) out += ",";
    out += "{\"severity\":" + pkg::quote(i.severity == pkg::Severity::Error ? "error" : "warning") +
           ",\"code\":" + pkg::quote(i.code) + ",\"message\":" + pkg::quote(i.message);
    if (!i.file.empty()) out += ",\"file\":" + pkg::quote(i.file);
    if (!i.id.empty()) out += ",\"id\":" + pkg::quote(i.id);
    out += "}";
  }
  return out + "]}";
}

int cmd_validate(int argc, char** argv) {
  if (argc < 3) return usage();
  bool json = argc > 3 && std::string_view(argv[3]) == "--json";
  auto files = load_files(argv[2]);
  if (!files) {
    if (json) std::printf("{\"ok\":false,\"error\":%s,\"issues\":[]}\n", pkg::quote(files.error()).c_str());
    else std::fprintf(stderr, "✗ %s\n", files.error().c_str());
    return 1;
  }
  pkg::LoadResult r = pkg::load_package(std::move(files).value());
  if (json) {
    std::printf("%s\n", issues_json(r).c_str());
  } else {
    print_issues(r.issues);
    size_t errors = 0;
    for (const pkg::Issue& i : r.issues) errors += i.severity == pkg::Severity::Error;
    if (r.ok) std::fprintf(stderr, "✓ valid (%zu warnings)\n", r.issues.size());
    else std::fprintf(stderr, "✗ %zu errors\n", errors);
  }
  return r.ok ? 0 : 1;
}

int cmd_info(int argc, char** argv) {
  if (argc < 3) return usage();
  auto files = load_files(argv[2]);
  if (!files) {
    std::fprintf(stderr, "✗ %s\n", files.error().c_str());
    return 1;
  }
  std::string hash = to_hex(files.value().content_hash());
  size_t file_count = files.value().count();
  uint64_t bytes = files.value().total_bytes();
  pkg::LoadResult r = pkg::load_package(std::move(files).value());
  std::printf("files      %zu (%llu bytes)\ncontent    sha256:%s\n", file_count, static_cast<unsigned long long>(bytes),
              hash.c_str());
  if (!r.ok) {
    print_issues(r.issues);
    return 1;
  }
  const pkg::Package& p = *r.package;
  const pkg::Manifest& m = p.manifest;
  size_t entities = 0;
  for (const auto& [_, s] : p.scenes) entities += s.entities.size();
  std::printf("name       %s\norientation %s (%dx%d)\nentry      %s\nplayers    %d-%d (server: %s)\n", m.name.c_str(),
              m.portrait() ? "portrait" : "landscape", m.reference_width(), m.reference_height(), m.entry_scene.c_str(),
              m.players_min, m.players_max, m.server_mode.c_str());
  std::string kits = m.kits ? pkg::join(*m.kits, ", ") : "-";
  std::printf("kits       %s\nstyle      %s\nscenes     %zu (%zu entities)\nassets     %zu\ndata       %zu tilesets, %zu anim sets, %zu sfx, %zu songs\n",
              kits.c_str(), m.style.preset.c_str(), p.scenes.size(), entities, p.assets.size(), p.tilesets.size(),
              p.anims.size(), p.sfx.size(), p.music.size());
  return 0;
}

int cmd_pack(int argc, char** argv) {
  if (argc < 4) return usage();
  auto files = load_files(argv[2]);
  if (!files) {
    std::fprintf(stderr, "✗ %s\n", files.error().c_str());
    return 1;
  }
  pkg::Files::Bytes packed = files.value().to_pack();
  std::string hash = to_hex(files.value().content_hash());
  pkg::LoadResult r = pkg::load_package(std::move(files).value());
  print_issues(r.issues);
  if (!r.ok) {
    std::fprintf(stderr, "✗ not packed: the package has errors\n");
    return 1;
  }
  if (Status s = write_file(argv[3], packed); !s) {
    std::fprintf(stderr, "✗ %s\n", s.error().c_str());
    return 1;
  }
  std::printf("%s  %zu bytes  sha256:%s\n", argv[3], packed.size(), hash.c_str());
  return 0;
}

int cmd_unpack(int argc, char** argv) {
  if (argc < 4) return usage();
  auto files = load_files(argv[2]);
  if (!files) {
    std::fprintf(stderr, "✗ %s\n", files.error().c_str());
    return 1;
  }
  const fs::path root = argv[3];
  for (const std::string& p : files.value().paths()) {
    fs::path out = root / p;  // paths are normalized: no "..", no absolute paths
    std::error_code ec;
    fs::create_directories(out.parent_path(), ec);
    if (ec) {
      std::fprintf(stderr, "✗ %s: %s\n", out.string().c_str(), ec.message().c_str());
      return 1;
    }
    if (Status s = write_file(out.string(), *files.value().bytes(p)); !s) {
      std::fprintf(stderr, "✗ %s\n", s.error().c_str());
      return 1;
    }
  }
  std::printf("%zu files -> %s\n", files.value().count(), argv[3]);
  return 0;
}

bool parse_int(const char* text, int64_t min, int64_t max, int64_t* out);

// Runs the package's scripts for N ticks with a fixed clock and prints the same report as
// engine/tests/conformance/ts_run.mts does for engine-web.
int cmd_run(int argc, char** argv) {
  if (argc < 3) return usage();
  int64_t ticks = 120, seed = 1, budget = 250;
  for (int i = 3; i < argc; i += 2) {
    std::string_view flag = argv[i];
    if (i + 1 >= argc) return usage();
    int64_t* target = flag == "--ticks" ? &ticks : flag == "--seed" ? &seed : flag == "--budget" ? &budget : nullptr;
    if (!target || !parse_int(argv[i + 1], 0, flag == "--seed" ? int64_t{0xffffffff} : 10000000, target)) return usage();
  }
  auto files = load_files(argv[2]);
  if (!files) {
    std::fprintf(stderr, "✗ %s\n", files.error().c_str());
    return 1;
  }
  pkg::LoadResult loaded = pkg::load_package(std::move(files).value());
  if (!loaded.ok) {
    print_issues(loaded.issues);
    return 1;
  }
  std::shared_ptr<const pkg::Package> package(std::move(loaded.package));
  script::HostOptions opts;
  opts.seed = static_cast<uint32_t>(seed);
  opts.budget_ms = static_cast<double>(budget);
  script::Host* host_ptr = nullptr;
  opts.clock = [&host_ptr] { return 1767225600.0 + (host_ptr ? host_ptr->time() : 0.0); };
  opts.on_log = [](const script::LogLine& l) { std::printf("[%s] %s\n", l.level.c_str(), l.text.c_str()); };
  auto host = script::Host::create(package, opts);
  if (!host) {
    std::fprintf(stderr, "✗ %s\n", host.error().c_str());
    return 1;
  }
  host_ptr = host.value().get();
  for (int64_t i = 0; i < ticks; ++i) host_ptr->step();
  auto num = [](double v) { return pkg::number_text(v); };
  for (const script::ScriptError& e : host_ptr->errors()) {
    std::printf("error %s:%d x%d: %s\n", e.script.c_str(), e.line, e.count, e.message.c_str());
  }
  for (const script::AudioEvent& a : host_ptr->audio_events()) {
    if (a.kind == "sfx") std::printf("audio sfx %s %s %s  %s\n", a.id.c_str(), num(a.volume).c_str(), num(a.pitch).c_str(), num(a.time).c_str());
    else if (a.kind == "music") std::printf("audio music %s   %s %s\n", a.id.c_str(), num(a.fade).c_str(), num(a.time).c_str());
    else std::printf("audio music_stop    %s %s\n", num(a.fade).c_str(), num(a.time).c_str());
  }
  std::printf("save %s\ntime %s\n", host_ptr->save_data().stringify().c_str(), num(host_ptr->time()).c_str());
  return 0;
}

// int64_t, not long: long is 32-bit on wasm32 and would overflow for seeds above 2^31.
bool parse_int(const char* text, int64_t min, int64_t max, int64_t* out) {
  char* end = nullptr;
  long long v = std::strtoll(text, &end, 10);
  if (end == text || *end != '\0' || v < min || v > max) return false;
  *out = v;
  return true;
}

int cmd_smoke(int argc, char** argv) {
  int64_t seed = 1, bodies = 20, steps = 300;
  for (int i = 2; i < argc; i += 2) {
    std::string_view flag = argv[i];
    if (i + 1 >= argc) return usage();
    int64_t* target = flag == "--seed" ? &seed : flag == "--bodies" ? &bodies : flag == "--steps" ? &steps : nullptr;
    int64_t max = flag == "--seed" ? int64_t{0xffffffff} : 100000;
    if (!target || !parse_int(argv[i + 1], 0, max, target)) return usage();
  }

  auto lua = dev::run_luau(
      "local function fib(n) if n < 2 then return n end return fib(n - 1) + fib(n - 2) end\n"
      "print(`luau ok: fib(20) = {fib(20)}`)\n");
  if (!lua) {
    log_error("luau: " + lua.error());
    return 1;
  }
  std::fputs(lua.value().c_str(), stdout);

  uint64_t hash = dev::physics_hash(static_cast<uint32_t>(seed), static_cast<int>(bodies), static_cast<int>(steps));
  std::printf("box2d ok: seed=%lld bodies=%lld steps=%lld hash=%016llx\n", static_cast<long long>(seed),
              static_cast<long long>(bodies), static_cast<long long>(steps), static_cast<unsigned long long>(hash));
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) return usage();
  std::string_view cmd = argv[1];
  if (cmd == "version") {
    std::printf("dreamsy engine %s\n", kEngineVersion);
    return 0;
  }
  if (cmd == "validate") return cmd_validate(argc, argv);
  if (cmd == "info") return cmd_info(argc, argv);
  if (cmd == "pack") return cmd_pack(argc, argv);
  if (cmd == "unpack") return cmd_unpack(argc, argv);
  if (cmd == "run") return cmd_run(argc, argv);
  if (cmd == "smoke") return cmd_smoke(argc, argv);
  return usage();
}
