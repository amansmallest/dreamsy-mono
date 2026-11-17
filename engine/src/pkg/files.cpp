#include "pkg/files.h"

#include <filesystem>
#include <fstream>
#include <set>
#include <system_error>

#include "pkg/text.h"

namespace dreamsy::pkg {

namespace fs = std::filesystem;

Result<std::string> normalize_path(std::string_view path) {
  std::string out;
  size_t start = 0;
  int segments = 0;
  for (size_t i = 0; i <= path.size(); ++i) {
    if (i < path.size() && path[i] != '/' && path[i] != '\\') continue;
    std::string_view seg = path.substr(start, i - start);
    start = i + 1;
    if (seg.empty() || seg == ".") continue;
    if (seg == "..") return Error{"path escapes package: " + std::string(path)};
    if (segments++) out += '/';
    out += seg;
  }
  if (out.empty()) return Error{"empty path"};
  return out;
}

Status Files::add_view(std::string path, std::shared_ptr<const Bytes> owner, View data, const Limits& limits) {
  if (path.size() > limits.max_path_bytes) return Error{"path longer than " + std::to_string(limits.max_path_bytes) + " bytes"};
  if (data.size() > limits.max_file_bytes) {
    return Error{path + " is " + std::to_string(data.size()) + " bytes; max " + std::to_string(limits.max_file_bytes)};
  }
  auto it = files_.find(path);
  if (it != files_.end()) {
    total_bytes_ -= it->second.data.size();
    it->second = Entry{std::move(owner), data};
  } else {
    if (files_.size() >= limits.max_files) return Error{"more than " + std::to_string(limits.max_files) + " files"};
    files_.emplace(std::move(path), Entry{std::move(owner), data});
  }
  total_bytes_ += data.size();
  if (total_bytes_ > limits.max_total_bytes) {
    return Error{"package is larger than " + std::to_string(limits.max_total_bytes) + " bytes"};
  }
  return Status::success();
}

Status Files::add(std::string path, Bytes data, const Limits& limits) {
  auto owner = std::make_shared<const Bytes>(std::move(data));
  View view(owner->data(), owner->size());
  return add_view(std::move(path), std::move(owner), view, limits);
}

void Files::strip_single_top_folder() {
  if (files_.empty() || files_.count("dreamsy.toml")) return;
  std::set<std::string_view> tops;
  for (const auto& [path, _] : files_) tops.insert(std::string_view(path).substr(0, path.find('/')));
  if (tops.size() != 1) return;
  const std::string top(*tops.begin());
  decltype(files_) stripped;
  for (auto& [path, entry] : files_) {
    if (path.size() <= top.size() + 1) continue;  // a file named exactly like the folder can't be stripped
    stripped.emplace(path.substr(top.size() + 1), std::move(entry));
  }
  files_ = std::move(stripped);
}

Result<Files> Files::from_dir(const std::string& dir, const Limits& limits) {
  std::error_code ec;
  if (!fs::is_directory(dir, ec)) return Error{dir + " is not a directory"};
  Files files;
  fs::recursive_directory_iterator it(dir, fs::directory_options::none, ec), end;
  if (ec) return Error{dir + ": " + ec.message()};
  for (; it != end; it.increment(ec)) {
    if (ec) return Error{dir + ": " + ec.message()};
    const fs::directory_entry& entry = *it;
    fs::file_status st = entry.symlink_status(ec);
    if (ec) return Error{entry.path().string() + ": " + ec.message()};
    if (!fs::is_regular_file(st) || entry.path().filename() == ".DS_Store") continue;  // skips symlinks too

    uintmax_t size = entry.file_size(ec);
    if (ec) return Error{entry.path().string() + ": " + ec.message()};
    std::string rel = fs::relative(entry.path(), dir, ec).generic_string();
    if (ec) return Error{entry.path().string() + ": " + ec.message()};
    if (size > limits.max_file_bytes) {
      return Error{rel + " is " + std::to_string(size) + " bytes; max " + std::to_string(limits.max_file_bytes)};
    }
    if (files.total_bytes_ + size > limits.max_total_bytes) {
      return Error{"package is larger than " + std::to_string(limits.max_total_bytes) + " bytes"};
    }
    Bytes data(static_cast<size_t>(size));
    std::ifstream in(entry.path(), std::ios::binary);
    if (!in.read(reinterpret_cast<char*>(data.data()), static_cast<std::streamsize>(data.size()))) {
      return Error{rel + ": read failed"};
    }
    auto path = normalize_path(rel);
    if (!path) return Error{rel + ": " + path.error()};
    if (Status s = files.add(std::move(path).value(), std::move(data), limits); !s) return Error{s.error()};
  }
  return files;
}

Result<Files> Files::from_map(const std::map<std::string, std::string>& in, const Limits& limits) {
  Files files;
  for (const auto& [raw, content] : in) {
    auto path = normalize_path(raw);
    if (!path) return Error{path.error()};
    if (Status s = files.add(std::move(path).value(), Bytes(content.begin(), content.end()), limits); !s) {
      return Error{s.error()};
    }
  }
  return files;
}

bool Files::has(std::string_view path) const { return bytes(path).has_value(); }

std::optional<Files::View> Files::bytes(std::string_view path) const {
  auto norm = normalize_path(path);
  if (!norm) return std::nullopt;
  auto it = files_.find(norm.value());
  if (it == files_.end()) return std::nullopt;
  return it->second.data;
}

std::optional<std::string_view> Files::text(std::string_view path) const {
  auto b = bytes(path);
  if (!b) return std::nullopt;
  return std::string_view(reinterpret_cast<const char*>(b->data()), b->size());
}

std::vector<std::string> Files::paths(std::string_view prefix) const {
  std::vector<std::string> out;
  for (auto it = files_.lower_bound(prefix); it != files_.end() && starts_with(it->first, prefix); ++it) {
    out.push_back(it->first);
  }
  return out;
}

}  // namespace dreamsy::pkg
