// Keep Metro out of panel/: it is the sandbox's web panel, a separate Vite
// app with its own node_modules (its own React among them), and nothing the
// phone app imports.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const panel = path.join(__dirname, "panel").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
config.resolver.blockList = [
  ...[].concat(config.resolver.blockList ?? []),
  new RegExp(`^${panel}[/\\\\].*`),
];

module.exports = config;
