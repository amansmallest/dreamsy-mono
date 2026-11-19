// Small text helpers shared by the package loader.
//
// Several rules come from the TypeScript validator (format/src), where string lengths are
// counted in UTF-16 code units and the patterns are JavaScript regexes. These helpers
// reproduce those rules exactly, so both validators accept and reject the same packages.
#pragma once

#include <string>
#include <string_view>
#include <vector>

namespace dreamsy::pkg {

// Length as JavaScript's String.length would report it (UTF-16 code units).
// Invalid UTF-8 bytes count as one unit each (they'd be U+FFFD after decoding).
size_t utf16_length(std::string_view s);

// Unicode code points (invalid bytes become U+FFFD).
std::vector<char32_t> code_points(std::string_view s);

bool is_js_space(char c);  // ASCII part of JavaScript's \s
std::string_view trim(std::string_view s);
bool starts_with(std::string_view s, std::string_view prefix);
bool ends_with(std::string_view s, std::string_view suffix);
bool iequals_at(std::string_view s, size_t pos, std::string_view lower_word);  // ASCII, case-insensitive
std::vector<std::string_view> split(std::string_view s, char sep);

bool is_lower(char c);
bool is_digit(char c);
bool is_word_char(char c);  // JavaScript \w

// ^[a-z][a-z0-9_]{0,max_rest}$
bool is_snake(std::string_view s, size_t max_rest);
// ^[a-z][a-z0-9_]{0,63}$ — entity and asset ids (format/src/schema.ts ID_RE)
inline bool is_id(std::string_view s) { return is_snake(s, 63); }
// ^[a-z][a-z0-9_]*$ — tags
bool is_tag(std::string_view s);
// ^#[0-9a-fA-F]{6}$ and ^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$
bool is_hex6_color(std::string_view s);
bool is_color(std::string_view s);

// ^<prefix><body>+<suffix>$ where every body char is in `body_chars`.
bool matches_path(std::string_view s, std::string_view prefix, std::string_view body_chars, std::string_view suffix);
// ^<prefix>[a-z][a-z0-9_]*<suffix>$
bool matches_snake_path(std::string_view s, std::string_view prefix, std::string_view suffix);

inline constexpr std::string_view kPathChars = "abcdefghijklmnopqrstuvwxyz0123456789_-/";  // [a-z0-9_\-/]
inline constexpr std::string_view kNameChars = "abcdefghijklmnopqrstuvwxyz0123456789_-";   // [a-z0-9_\-]

// JSON.stringify for a string, for error messages.
std::string quote(std::string_view s);
// Shortest round-trip number text, like JavaScript's String(n) for typical values.
std::string number_text(double v);
std::string join(const std::vector<std::string>& parts, std::string_view sep);

}  // namespace dreamsy::pkg
