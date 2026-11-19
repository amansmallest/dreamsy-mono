#include "base/log.h"

#include <cstdio>
#include <cstdlib>

#include "base/check.h"

namespace dreamsy {

namespace {

void stderr_sink(LogLevel level, std::string_view message, void*) {
  std::fprintf(stderr, "[%s] %.*s\n", log_level_name(level), static_cast<int>(message.size()),
               message.data());
}

LogSink g_sink = stderr_sink;
void* g_sink_user = nullptr;
LogLevel g_min_level = LogLevel::Info;

}  // namespace

void log(LogLevel level, std::string_view message) {
  if (level < g_min_level) return;
  g_sink(level, message, g_sink_user);
}

void set_log_sink(LogSink sink, void* user) {
  g_sink = sink ? sink : stderr_sink;
  g_sink_user = sink ? user : nullptr;
}

void set_log_level(LogLevel min_level) { g_min_level = min_level; }

const char* log_level_name(LogLevel level) {
  switch (level) {
    case LogLevel::Debug: return "debug";
    case LogLevel::Info: return "info";
    case LogLevel::Warn: return "warn";
    case LogLevel::Error: return "error";
  }
  return "?";
}

void check_failed(const char* expr, const char* msg, const char* file, int line) {
  // Write straight to stderr: the log sink might be what is broken.
  std::fprintf(stderr, "[fatal] %s:%d: check `%s` failed: %s\n", file, line, expr, msg);
  std::fflush(stderr);
  std::abort();
}

}  // namespace dreamsy
