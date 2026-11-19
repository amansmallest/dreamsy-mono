// Runs a fuzz target without libFuzzer (any compiler, including Apple clang):
//   <target>-replay <file|dir>...                 run each input once (regression corpus)
//   <target>-replay --mutate N [--seed S] <...>   also run N random mutations of each input
// With DREAMSY_FUZZ_SAVE=<file>, each input is written there before it runs, so after a crash
// the file holds the input that caused it.
// Build with the debug preset so AddressSanitizer/UBSan catch memory errors. libFuzzer builds
// (DREAMSY_FUZZ=ON, clang with -fsanitize=fuzzer) use the same targets with coverage guidance.
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "base/rng.h"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size);

namespace {

std::vector<uint8_t> read_all(const std::filesystem::path& p) {
  std::ifstream in(p, std::ios::binary);
  return {std::istreambuf_iterator<char>(in), {}};
}

void mutate(std::vector<uint8_t>& b, dreamsy::Rng& rng, const std::vector<std::vector<uint8_t>>& pool) {
  auto pick = [&](size_t n) { return n ? static_cast<size_t>(rng.next_u32() % n) : 0; };
  int edits = 1 + static_cast<int>(rng.next_u32() % 4);
  for (int e = 0; e < edits; ++e) {
    switch (rng.next_u32() % 7) {
      case 0: if (!b.empty()) b[pick(b.size())] ^= static_cast<uint8_t>(1u << (rng.next_u32() % 8)); break;
      case 1: if (!b.empty()) b[pick(b.size())] = static_cast<uint8_t>(rng.next_u32()); break;
      case 2: b.insert(b.begin() + static_cast<long>(pick(b.size() + 1)), static_cast<uint8_t>(rng.next_u32())); break;
      case 3: if (!b.empty()) { size_t at = pick(b.size()), n = 1 + pick(std::min<size_t>(64, b.size() - at)); b.erase(b.begin() + static_cast<long>(at), b.begin() + static_cast<long>(at + n)); } break;
      case 4: if (!b.empty()) { static const uint8_t magic[] = {0x00, 0xff, 0x7f, 0x80, '"', '{', '}', '[', ']', '\\', '\n', '='}; b[pick(b.size())] = magic[rng.next_u32() % sizeof magic]; } break;
      case 5: if (b.size() > 8) b.resize(pick(b.size())); break;  // truncate
      case 6: if (!pool.empty()) { const auto& other = pool[pick(pool.size())]; if (!other.empty()) { size_t from = pick(other.size()), n = 1 + pick(std::min<size_t>(256, other.size() - from)); b.insert(b.begin() + static_cast<long>(pick(b.size() + 1)), other.begin() + static_cast<long>(from), other.begin() + static_cast<long>(from + n)); } } break;
    }
  }
}

}  // namespace

int main(int argc, char** argv) {
  long mutations = 0;
  uint32_t seed = 1;
  std::vector<std::vector<uint8_t>> inputs;
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    if (a == "--mutate" && i + 1 < argc) { mutations = std::atol(argv[++i]); continue; }
    if (a == "--seed" && i + 1 < argc) { seed = static_cast<uint32_t>(std::strtoul(argv[++i], nullptr, 10)); continue; }
    std::filesystem::path p(a);
    if (std::filesystem::is_directory(p)) {
      for (const auto& e : std::filesystem::directory_iterator(p))
        if (e.is_regular_file()) inputs.push_back(read_all(e.path()));
    } else {
      inputs.push_back(read_all(p));
    }
  }
  if (inputs.empty()) {
    std::fprintf(stderr, "usage: %s [--mutate N] [--seed S] <file|dir>...\n", argv[0]);
    return 2;
  }
  dreamsy::Rng rng(seed);
  const char* save_path = std::getenv("DREAMSY_FUZZ_SAVE");
  auto run = [&](const std::vector<uint8_t>& b) {
    if (save_path) std::ofstream(save_path, std::ios::binary | std::ios::trunc).write(reinterpret_cast<const char*>(b.data()), static_cast<std::streamsize>(b.size()));
    LLVMFuzzerTestOneInput(b.data(), b.size());
  };
  long runs = 0;
  for (const auto& in : inputs) {
    run(in);
    ++runs;
    for (long k = 0; k < mutations; ++k) {
      std::vector<uint8_t> m = in;
      mutate(m, rng, inputs);
      run(m);
      ++runs;
    }
  }
  std::printf("%ld runs over %zu inputs, no crashes\n", runs, inputs.size());
  return 0;
}
