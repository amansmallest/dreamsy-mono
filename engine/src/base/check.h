// Runtime checks.
//
// DREAMSY_CHECK(cond, msg) runs in every build. Use it where a failed check would otherwise
// become memory corruption (bad index, stale handle). It logs and aborts: a clear crash
// beats silent undefined behavior.
//
// DREAMSY_ASSERT(cond) runs in debug builds only. Use it for internal invariants that are
// too hot to check in release.
#pragma once

namespace dreamsy {

[[noreturn]] void check_failed(const char* expr, const char* msg, const char* file, int line);

}  // namespace dreamsy

#define DREAMSY_CHECK(cond, msg)                                         \
  do {                                                                   \
    if (!(cond)) ::dreamsy::check_failed(#cond, (msg), __FILE__, __LINE__); \
  } while (0)

#ifdef NDEBUG
#define DREAMSY_ASSERT(cond) ((void)0)
#else
#define DREAMSY_ASSERT(cond) DREAMSY_CHECK(cond, "assertion failed")
#endif
