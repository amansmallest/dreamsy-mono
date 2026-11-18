// The web player's embedding contract (docs/platform.md §6), linked with --pre-js so it runs inside the module
// (it can reach HEAPU8 and the exported _dreamsy_* functions). main.cpp calls it through EM_JS.
//
// Package source, from the query (first match wins; the download starts before the WASM is compiled):
//   ?public=<gameId> (or a /g/<gameId> path)   the published version: GET <api>/v1/public/games/<id>/package
//                                              (<api> = ?api=, else api.<domain> on play.<domain>, else this host :8787)
//   ?api=<base>&game=<id>&version=<n>[&token=] GET <api>/v1/games/<id>/versions/<n>/package with the bearer token
//                                              (?token=, else localStorage dreamsy_token); version defaults to latest
//   ?pkg=<url>                                 a .dpk or .zip (tools, dev); &kits=<base url> for the kit packs
// Packages are sniffed (zip or Dreamsy pack), so the URL needs no extension.
//
// Embed mode (?embed=1, inside a react-native-webview, or ?public=): messages to the host app, as a JSON string
// to window.ReactNativeWebView.postMessage and, inside an iframe, as an object to window.parent.postMessage(msg, "*"):
//   {type:"ready"}                      the game is running
//   {type:"error", message}             a load failure (before ready), or a script error (after; at most one per 2 s,
//                                       the same message at most every 30 s)
//   {type:"quit"}                       pause menu Quit
//   {type:"runEnd", reason, board?, value?}  leaderboard finish/submit, platform.runEnded(reason) or a room
//                                       finished; at most one per 3 s
// ?insets=top,right,bottom,left (CSS px, 0-400): the host's safe-area insets (pause button, menu, touch controls
// and the game's UI anchors keep clear of them).
var dreamsyHost = (function () {
  var q = new URLSearchParams(location.search);
  var path = location.pathname.split("/");
  var g = path.indexOf("g");
  var publicId = q.get("public") || (g >= 0 && path[g + 1] ? decodeURIComponent(path[g + 1]) : "");
  var host = {
    embed: q.get("embed") === "1" || !!window.ReactNativeWebView || !!publicId,
    insets: [0, 0, 0, 0],
    source: "",   // a short name for logs and errors
    error: "",    // the download error, read by main.cpp after _dreamsy_package_failed
    download: null,
  };

  var ins = (q.get("insets") || "").split(",").map(Number);
  if (ins.length === 4 && ins.every(function (n) { return isFinite(n) && n >= 0 && n <= 400; })) host.insets = ins;

  function token() {
    var t = q.get("token");
    if (t !== null) return t;
    try { return localStorage.getItem("dreamsy_token") || ""; } catch (e) { return ""; }
  }

  var req = null;
  var api = (q.get("api") || "").replace(/\/$/, "");
  if (publicId) {
    var base = api || (location.hostname.indexOf("play.") === 0
      ? "https://api." + location.hostname.slice(5)
      : location.protocol + "//" + location.hostname + ":8787");
    req = { url: base + "/v1/public/games/" + encodeURIComponent(publicId) + "/package", api: true, isPublic: true };
    host.source = publicId;
  } else if (api && q.get("game")) {
    var version = q.get("version") || "latest";
    var t = token();
    req = {
      url: api + "/v1/games/" + encodeURIComponent(q.get("game")) + "/versions/" + encodeURIComponent(version) + "/package",
      headers: t ? { authorization: "Bearer " + t } : {}, api: true,
    };
    host.source = q.get("game") + "@" + version;
  } else if (q.get("pkg")) {
    req = { url: q.get("pkg"), cache: "no-store" };
    host.source = q.get("pkg");
  }

  if (req) {
    host.download = fetch(req.url, { headers: req.headers || {}, cache: req.cache || "default" }).then(function (res) {
      if (res.ok) return res.arrayBuffer();
      return res.text().catch(function () { return ""; }).then(function (body) {
        if (req.isPublic && res.status === 404) throw new Error("This game isn't published (or was removed).");
        throw new Error((req.api ? "API " : "can't download " + req.url + ": ") + res.status + (body ? ": " + body.slice(0, 200) : ""));
      });
    }, function (e) {
      throw new Error("can't download the game (" + (e && e.message ? e.message : e) + ")");
    });
    host.download.catch(function () {});  // handled when main.cpp asks for it
  }

  // Hands the package to main.cpp (once the runtime is up): _dreamsy_package_ready or _dreamsy_package_failed.
  host.deliver = function () {
    host.download.then(function (buf) {
      var bytes = new Uint8Array(buf);
      var ptr = _dreamsy_package_buffer(bytes.length);
      HEAPU8.set(bytes, ptr);  // after the call: the buffer may have grown memory
      _dreamsy_package_ready();
    }, function (e) {
      host.error = String(e && e.message ? e.message : e);
      _dreamsy_package_failed();
    });
  };

  host.post = function (json) {
    if (!host.embed) return;
    try { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(json); } catch (e) { /* host gone */ }
    if (window.parent && window.parent !== window) {
      try { window.parent.postMessage(JSON.parse(json), "*"); } catch (e) { /* parent gone */ }
    }
  };

  host.quit = function () {
    if (host.embed) host.post(JSON.stringify({ type: "quit" }));
    else if (history.length > 1) history.back();
    else location.href = "../";
  };

  return host;
})();
