#include "pkg/text.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace dreamsy::pkg {

namespace {

// Decodes one UTF-8 sequence at s[i]. Returns the code point and advances i.
// Invalid or truncated sequences yield U+FFFD and consume one byte.
char32_t decode_one(std::string_view s, size_t& i) {
  auto b = [&](size_t k) { return static_cast<unsigned char>(s[k]); };
  unsigned char c = b(i);
  if (c < 0x80) {
    ++i;
    return c;
  }
  int len = (c >> 5) == 0x6 ? 2 : (c >> 4) == 0xE ? 3 : (c >> 3) == 0x1E ? 4 : 0;
  if (len == 0 || i + len > s.size()) {
    ++i;
    return 0xFFFD;
  }
  char32_t cp = c & (0xFF >> (len + 1));
  for (int k = 1; k < len; ++k) {
    unsigned char cc = b(i + k);
    if ((cc >> 6) != 0x2) {
      ++i;
      return 0xFFFD;
    }
    cp = (cp << 6) | (cc & 0x3F);
  }
  // Reject overlong encodings, surrogates and out-of-range values.
  const char32_t min_for_len[] = {0, 0, 0x80, 0x800, 0x10000};
  if (cp < min_for_len[len] || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) {
    ++i;
    return 0xFFFD;
  }
  i += len;
  return cp;
}

}  // namespace

size_t utf16_length(std::string_view s) {
  size_t n = 0;
  for (size_t i = 0; i < s.size();) n += decode_one(s, i) > 0xFFFF ? 2 : 1;
  return n;
}

std::vector<char32_t> code_points(std::string_view s) {
  std::vector<char32_t> out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size();) out.push_back(decode_one(s, i));
  return out;
}

bool is_js_space(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f'; }

std::string_view trim(std::string_view s) {
  while (!s.empty() && is_js_space(s.front())) s.remove_prefix(1);
  while (!s.empty() && is_js_space(s.back())) s.remove_suffix(1);
  return s;
}

bool starts_with(std::string_view s, std::string_view prefix) { return s.substr(0, prefix.size()) == prefix; }

bool ends_with(std::string_view s, std::string_view suffix) {
  return s.size() >= suffix.size() && s.substr(s.size() - suffix.size()) == suffix;
}

bool iequals_at(std::string_view s, size_t pos, std::string_view lower_word) {
  if (pos > s.size() || s.size() - pos < lower_word.size()) return false;
  for (size_t i = 0; i < lower_word.size(); ++i) {
    char c = s[pos + i];
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    if (c != lower_word[i]) return false;
  }
  return true;
}

std::vector<std::string_view> split(std::string_view s, char sep) {
  std::vector<std::string_view> out;
  size_t start = 0;
  for (size_t i = 0; i <= s.size(); ++i) {
    if (i == s.size() || s[i] == sep) {
      out.push_back(s.substr(start, i - start));
      start = i + 1;
    }
  }
  return out;
}

bool is_lower(char c) { return c >= 'a' && c <= 'z'; }
bool is_digit(char c) { return c >= '0' && c <= '9'; }
bool is_word_char(char c) { return is_lower(c) || (c >= 'A' && c <= 'Z') || is_digit(c) || c == '_'; }

bool is_snake(std::string_view s, size_t max_rest) {
  if (s.empty() || s.size() > max_rest + 1 || !is_lower(s[0])) return false;
  for (char c : s.substr(1))
    if (!is_lower(c) && !is_digit(c) && c != '_') return false;
  return true;
}

bool is_tag(std::string_view s) { return is_snake(s, std::string_view::npos - 1); }

namespace {
bool is_hex(char c) { return is_digit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }
bool all_hex(std::string_view s) {
  for (char c : s)
    if (!is_hex(c)) return false;
  return true;
}
}  // namespace

bool is_hex6_color(std::string_view s) { return s.size() == 7 && s[0] == '#' && all_hex(s.substr(1)); }

bool is_color(std::string_view s) { return (s.size() == 7 || s.size() == 9) && s[0] == '#' && all_hex(s.substr(1)); }

bool matches_path(std::string_view s, std::string_view prefix, std::string_view body_chars, std::string_view suffix) {
  if (s.size() < prefix.size() + suffix.size() + 1 || !starts_with(s, prefix) || !ends_with(s, suffix)) return false;
  std::string_view body = s.substr(prefix.size(), s.size() - prefix.size() - suffix.size());
  for (char c : body)
    if (body_chars.find(c) == std::string_view::npos) return false;
  return true;
}

bool matches_snake_path(std::string_view s, std::string_view prefix, std::string_view suffix) {
  if (s.size() < prefix.size() + suffix.size() + 1 || !starts_with(s, prefix) || !ends_with(s, suffix)) return false;
  return is_tag(s.substr(prefix.size(), s.size() - prefix.size() - suffix.size()));
}

std::string quote(std::string_view s) {
  std::string out = "\"";
  for (char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\u%04x", c);
          out += buf;
        } else {
          out += c;
        }
    }
  }
  return out + "\"";
}

std::string number_text(double v) {
  if (std::isnan(v)) return "NaN";
  if (std::isinf(v)) return v > 0 ? "Infinity" : "-Infinity";
  if (v == std::floor(v) && std::fabs(v) < 1e15) {
    char buf[32];
    std::snprintf(buf, sizeof buf, "%.0f", v);
    return buf;
  }
  // Shortest representation that round-trips.
  char buf[32];
  for (int precision = 1; precision <= 17; ++precision) {
    std::snprintf(buf, sizeof buf, "%.*g", precision, v);
    if (std::strtod(buf, nullptr) == v) break;
  }
  return buf;
}

std::string join(const std::vector<std::string>& parts, std::string_view sep) {
  std::string out;
  for (size_t i = 0; i < parts.size(); ++i) {
    if (i) out += sep;
    out += parts[i];
  }
  return out;
}

}  // namespace dreamsy::pkg
