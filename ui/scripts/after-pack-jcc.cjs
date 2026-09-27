const path = require("node:path");
const { pathToFileURL } = require("node:url");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  const { verifyPackagedDaemon } = await import(pathToFileURL(path.join(__dirname, "../../tools/verify-jcc-packaged-daemon.mjs")).href);
  await verifyPackagedDaemon(context.appOutDir);
};
