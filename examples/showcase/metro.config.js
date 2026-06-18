const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
// Repo root is two levels up: examples/showcase → examples → <root>
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Watch all files within the monorepo
config.watchFolders = [workspaceRoot];

// Resolve modules from both the project and workspace roots
// Project root MUST come first to avoid version mismatches
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Force resolution of packages from workspace node_modules
config.resolver.extraNodeModules = {
  'react-native': path.resolve(workspaceRoot, 'node_modules/react-native'),
  react: path.resolve(workspaceRoot, 'node_modules/react'),
  'expo-router': path.resolve(workspaceRoot, 'node_modules/expo-router'),
};

// Allow hierarchical lookup for proper monorepo resolution
config.resolver.disableHierarchicalLookup = false;

module.exports = config;
