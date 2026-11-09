// Loaded before the app bundle (classic script, allowed by CSP 'self').
// If the app fails to start, show the error instead of an empty dark window.
(function () {
  function show(msg) {
    var root = document.getElementById("root");
    if (!root || root.childElementCount > 0) return; // app rendered; let it handle errors
    root.innerHTML = "";
    var box = document.createElement("div");
    box.style.cssText = "font:14px/1.5 system-ui,sans-serif;color:#e6e9f2;background:#0f1117;position:fixed;inset:0;padding:40px;overflow:auto";
    var h = document.createElement("h2");
    h.textContent = "Keystone failed to start";
    h.style.cssText = "margin:0 0 12px;font-weight:600";
    var p = document.createElement("p");
    p.textContent = "Please report this error:";
    p.style.cssText = "color:#9aa3b5;margin:0 0 12px";
    var pre = document.createElement("pre");
    pre.textContent = msg;
    pre.style.cssText = "white-space:pre-wrap;background:#171a23;border:1px solid #2a2f3d;border-radius:8px;padding:16px;font:12px/1.5 ui-monospace,monospace;user-select:text";
    box.append(h, p, pre);
    root.appendChild(box);
  }
  window.addEventListener("error", function (e) {
    show(String(e.message) + (e.error && e.error.stack ? "\n\n" + e.error.stack : ""));
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    show("Unhandled promise rejection: " + (r && r.stack ? r.stack : String(r)));
  });
  window.__keystoneFatal = show;
})();
