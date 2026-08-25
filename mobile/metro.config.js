/** Metro config for the Atlas monorepo: the app lives in mobile/, while
 * workspace packages (@atlas/shared) live in ../packages and are symlinked by
 * npm into the root node_modules. Watching the workspace root + resolving
 * through BOTH node_modules trees is Expo's documented monorepo setup; without
 * it Metro resolves @atlas/shared to a file outside any watched root and the
 * bundler either misses changes or refuses the module outright. */
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
