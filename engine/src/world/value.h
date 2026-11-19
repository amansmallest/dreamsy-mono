// A runtime entity property value.
//
// Scene files and scripts give props as numbers, booleans, strings, vectors and colors. At run time
// every prop is one of these four shapes (engine-web keeps the same shapes as plain JS values):
//
//   Number   numbers, ints                      v[0]
//   Bool     booleans                           b
//   String   strings, enums, "asset:<id>", entity ids
//   Vec      Vec2 (n = 2), Vec3 (n = 3), colors as RGBA 0..1 (n = 4)
#pragma once

#include <cstdint>
#include <string>
#include <utility>

namespace dreamsy::world {

enum class ValueKind : uint8_t { Number, Bool, String, Vec };

struct Value {
  ValueKind kind = ValueKind::Number;
  uint8_t n = 0;              // Vec: component count (2, 3 or 4)
  double v[4] = {0, 0, 0, 0};  // Number: v[0]; Vec: v[0..n)
  bool b = false;
  std::string s;

  static Value number(double x) {
    Value out;
    out.v[0] = x;
    return out;
  }
  static Value boolean(bool x) {
    Value out;
    out.kind = ValueKind::Bool;
    out.b = x;
    return out;
  }
  static Value string(std::string x) {
    Value out;
    out.kind = ValueKind::String;
    out.s = std::move(x);
    return out;
  }
  static Value vec(double x, double y) { return vec_n(2, x, y, 0, 0); }
  static Value vec3(double x, double y, double z) { return vec_n(3, x, y, z, 0); }
  static Value color(double r, double g, double blue, double a) { return vec_n(4, r, g, blue, a); }

  bool is_number() const { return kind == ValueKind::Number; }
  bool is_vec(int count) const { return kind == ValueKind::Vec && n == count; }

  friend bool operator==(const Value& x, const Value& y) {
    if (x.kind != y.kind) return false;
    switch (x.kind) {
      case ValueKind::Number: return x.v[0] == y.v[0];
      case ValueKind::Bool: return x.b == y.b;
      case ValueKind::String: return x.s == y.s;
      case ValueKind::Vec:
        if (x.n != y.n) return false;
        for (int i = 0; i < x.n; ++i)
          if (x.v[i] != y.v[i]) return false;
        return true;
    }
    return false;
  }

 private:
  static Value vec_n(int count, double x, double y, double z, double w) {
    Value out;
    out.kind = ValueKind::Vec;
    out.n = static_cast<uint8_t>(count);
    out.v[0] = x, out.v[1] = y, out.v[2] = z, out.v[3] = w;
    return out;
  }
};

// "#rgb", "#rrggbb" or "#rrggbbaa" (optional "#") -> RGBA 0..1; false if it isn't a color.
// Same rules as engine-web/core/world.ts parseColor for strings.
bool parse_color(std::string_view text, double out[4]);

}  // namespace dreamsy::world
