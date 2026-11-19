#include "script/require_path.h"

#include <algorithm>

#include "pkg/text.h"

namespace dreamsy::script {

namespace {

bool is_kit_name(std::string_view s) {
  if (s.empty() || s.size() > 32 || !pkg::is_lower(s[0])) return false;
  for (char c : s)
    if (!pkg::is_lower(c) && !pkg::is_digit(c) && c != '-') return false;
  return true;
}

// "kits/<kit>/..." -> "<kit>", else empty.
std::string kit_of(const std::string& path) {
  if (!pkg::starts_with(path, "kits/")) return {};
  size_t slash = path.find('/', 5);
  if (slash == std::string::npos) return {};
  std::string kit = path.substr(5, slash - 5);
  return is_kit_name(kit) ? kit : std::string();
}

}  // namespace

Result<std::string> resolve_require(const std::string& from, const std::string& name,
                                    const std::vector<std::string>& enabled_kits,
                                    const std::function<bool(const std::string&)>& kit_exists) {
  auto kit_source = [&](const std::string& p) { return kit_exists(p); };
  const std::string req = "require(\"" + name + "\")";
  if (pkg::starts_with(name, "@")) {
    // ^@kit/([a-z][a-z0-9-]{0,31})(?:/([a-z0-9_\-/]+))?$
    bool ok = pkg::starts_with(name, "@kit/");
    std::string kit, sub;
    if (ok) {
      std::string rest = name.substr(5);
      size_t slash = rest.find('/');
      kit = rest.substr(0, slash);
      ok = is_kit_name(kit);
      if (ok && slash != std::string::npos) {
        sub = rest.substr(slash + 1);
        ok = !sub.empty() && std::all_of(sub.begin(), sub.end(), [](char c) { return pkg::kPathChars.find(c) != std::string_view::npos; });
      }
    }
    if (!ok) return Error{req + ": kits are required as \"@kit/<kit>\" or \"@kit/<kit>/<module>\""};
    if (std::find(enabled_kits.begin(), enabled_kits.end(), kit) == enabled_kits.end()) {
      std::string from_kit = kit_of(from);
      return Error{from_kit.empty()
                   ? req + ": kit \"" + kit + "\" is not enabled (add kits = [\"" + kit + "\"] to dreamsy.toml)"
                   : req + " in kit \"" + from_kit + "\": kit \"" + kit + "\" is not enabled (declare it in kits/" + from_kit + "/kit.json \"requires\")"};
    }
    if (sub.empty()) sub = "init";
    while (!sub.empty() && sub.back() == '/') sub.pop_back();
    for (std::string_view seg : pkg::split(sub, '/'))
      if (seg.empty() || seg == "." || seg == "..") return Error{req + ": bad kit module path"};
    std::string path = "kits/" + kit + "/" + sub + ".luau";
    if (!kit_source(path) && kit_source("kits/" + kit + "/" + sub + "/init.luau")) path = "kits/" + kit + "/" + sub + "/init.luau";
    if (!kit_source(path)) {
      return Error{req + ": kit module " + path + " not found" +
                   (kit_source("kits/" + kit + "/init.luau") ? "" : " (kit \"" + kit + "\" is not bundled with this engine)")};
    }
    return path;
  }

  std::string in_kit = kit_of(from);
  std::vector<std::string> parts;
  for (std::string_view seg : pkg::split(from, '/')) parts.emplace_back(seg);
  parts.pop_back();  // the file name
  size_t floor = in_kit.empty() ? 1 : 2;  // can't climb above scripts/ or kits/<kit>/
  std::string n = name;
  if (pkg::ends_with(n, ".luau")) n = n.substr(0, n.size() - 5);
  for (std::string_view seg : pkg::split(n, '/')) {
    if (seg.empty() || seg == ".") continue;
    if (seg == "..") {
      if (parts.size() <= floor) return Error{req + " escapes " + (in_kit.empty() ? std::string("scripts/") : "kits/" + in_kit + "/")};
      parts.pop_back();
    } else {
      parts.emplace_back(seg);
    }
  }
  std::string path;
  for (size_t i = 0; i < parts.size(); ++i) path += (i ? "/" : "") + parts[i];
  path += ".luau";
  if (!in_kit.empty()) {
    if (!pkg::starts_with(path, "kits/" + in_kit + "/")) return Error{req + ": kit modules can only require modules of their own kit"};
    if (!kit_source(path)) return Error{req + ": kit module " + path + " not found"};
    return path;
  }
  if (!pkg::starts_with(path, "scripts/")) return Error{req + ": only modules under scripts/ (or \"@kit/<kit>\") can be required"};
  return path;
}


}  // namespace dreamsy::script
