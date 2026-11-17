// Errors as values.
//
// A function that can fail returns Result<T> (a value or an error message) or Status
// (success or an error message). Engine code never throws.
//
//   Result<Package> load(std::string_view path) {
//     if (path.empty()) return Error{"empty path"};
//     return Package{...};
//   }
//
//   auto pkg = load(path);
//   if (!pkg) { log_error(pkg.error()); return; }
//   use(pkg.value());
#pragma once

#include <optional>
#include <string>
#include <utility>

#include "base/check.h"

namespace dreamsy {

struct Error {
  std::string message;
};

template <typename T>
class [[nodiscard]] Result {
 public:
  Result(T value) : value_(std::move(value)) {}  // NOLINT: implicit on purpose, so `return value;` works
  Result(Error error) : error_(std::move(error.message)) {}  // NOLINT: same for `return Error{...};`

  bool ok() const { return value_.has_value(); }
  explicit operator bool() const { return ok(); }

  T& value() & {
    DREAMSY_CHECK(ok(), "Result::value() on an error");
    return *value_;
  }
  const T& value() const& {
    DREAMSY_CHECK(ok(), "Result::value() on an error");
    return *value_;
  }
  T&& value() && {
    DREAMSY_CHECK(ok(), "Result::value() on an error");
    return std::move(*value_);
  }

  // Empty when ok().
  const std::string& error() const { return error_; }

 private:
  std::optional<T> value_;
  std::string error_;
};

class [[nodiscard]] Status {
 public:
  Status() = default;  // success
  Status(Error error) : error_(std::move(error.message)), ok_(false) {}  // NOLINT: implicit on purpose

  static Status success() { return {}; }

  bool ok() const { return ok_; }
  explicit operator bool() const { return ok_; }
  const std::string& error() const { return error_; }

 private:
  std::string error_;
  bool ok_ = true;
};

}  // namespace dreamsy
