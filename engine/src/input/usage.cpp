#include "input/usage.h"

namespace dreamsy::input {

namespace {

bool is_space(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; }
bool is_word(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
}

// A tiny cursor over the source; each match step skips whitespace first (the regexes' \s*).
struct Cursor {
  std::string_view s;
  size_t i;

  void skip_space() {
    while (i < s.size() && is_space(s[i])) i++;
  }
  bool eat(std::string_view word) {
    skip_space();
    if (s.substr(i, word.size()) != word) return false;
    i += word.size();
    return true;
  }
  bool eat_quote() {
    skip_space();
    if (i < s.size() && (s[i] == '"' || s[i] == '\'')) {
      i++;
      return true;
    }
    return false;
  }
};

}  // namespace

// Matches `input\s*\.\s*(pressed|held|axis)\s*\(\s*["']<name>` at every "input" in the source.
InputUsage detect_input_usage(std::string_view source) {
  InputUsage usage;
  for (size_t at = source.find("input"); at != std::string_view::npos; at = source.find("input", at + 1)) {
    Cursor c{source, at + 5};
    if (!c.eat(".")) continue;
    c.skip_space();
    const bool is_axis = c.s.substr(c.i, 4) == "axis";
    if (!is_axis && !c.eat("pressed") && !c.eat("held")) continue;
    if (is_axis) c.i += 4;
    if (!c.eat("(") || !c.eat_quote()) continue;
    const std::string_view rest = source.substr(c.i);
    if (is_axis) {
      if (rest.substr(0, 5) == "move_") usage.move = true;
      if (rest.substr(0, 5) == "look_") usage.look = true;
      continue;
    }
    // (\w+)["'] : a word, then a closing quote
    size_t n = 0;
    while (n < rest.size() && is_word(rest[n])) n++;
    if (n > 0 && n < rest.size() && (rest[n] == '"' || rest[n] == '\'')) usage.buttons.emplace(rest.substr(0, n));
  }
  return usage;
}

bool scripts_mention_move_y(std::string_view game_scripts) { return game_scripts.find("move_y") != std::string_view::npos; }

}  // namespace dreamsy::input
