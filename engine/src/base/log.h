// Logging.
//
// All engine output goes through log(). By default it prints to stderr; tools and tests can
// install their own sink (for example to capture script output or to forward it to the
// browser console).
#pragma once

#include <string_view>

namespace dreamsy {

enum class LogLevel { Debug, Info, Warn, Error };

// A sink receives every message at or above the current minimum level.
using LogSink = void (*)(LogLevel level, std::string_view message, void* user);

void log(LogLevel level, std::string_view message);
void set_log_sink(LogSink sink, void* user);  // nullptr restores the default stderr sink
void set_log_level(LogLevel min_level);
const char* log_level_name(LogLevel level);

inline void log_debug(std::string_view m) { log(LogLevel::Debug, m); }
inline void log_info(std::string_view m) { log(LogLevel::Info, m); }
inline void log_warn(std::string_view m) { log(LogLevel::Warn, m); }
inline void log_error(std::string_view m) { log(LogLevel::Error, m); }

}  // namespace dreamsy
