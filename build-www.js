// Salin file website ke folder www/ untuk dibungkus jadi aplikasi Android (Capacitor).
const fs = require("fs"), path = require("path");
const out = path.join(__dirname, "www");
const files = ["index.html", "style.css", "script.js", "config.js", "privacy.html", "manifest.webmanifest", "sw.js"];
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of files) fs.copyFileSync(path.join(__dirname, f), path.join(out, f));
fs.cpSync(path.join(__dirname, "icons"), path.join(out, "icons"), { recursive: true });
console.log("www/ siap:", fs.readdirSync(out).join(", "));
