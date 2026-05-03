const { withDangerousMod, withXcodeProject } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Expo config plugin for Ennio E2E testing
 *
 * This plugin conditionally includes the @ennio/core native module.
 * By default, it's only included in non-production builds.
 *
 * Usage:
 *   // app.json - include in all builds
 *   ["@ennio/expo-plugin"]
 *
 *   // app.json - configure options
 *   ["@ennio/expo-plugin", { "enabled": true }]
 *
 * Set ENNIO_ENABLED=0 environment variable to disable at prebuild time.
 */

function withEnnioIOS(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const podfilePath = path.join(
        config.modRequest.platformProjectRoot,
        'Podfile'
      );

      if (!fs.existsSync(podfilePath)) {
        return config;
      }

      let podfile = fs.readFileSync(podfilePath, 'utf-8');

      // Check if already modified
      if (podfile.includes('# Ennio E2E Testing')) {
        return config;
      }

      // Add conditional pod inclusion before post_install block
      // Support both standard and monorepo layouts
      const ennioConfig = `
  # Ennio E2E Testing - conditionally included
  # Set ENNIO_ENABLED=0 to disable
  if ENV['ENNIO_ENABLED'] != '0'
    # Try standard layout first, then monorepo layout
    ennio_path = File.join(__dir__, '..', 'node_modules', '@ennio', 'nitro')
    ennio_path = File.join(__dir__, '..', '..', 'node_modules', '@ennio', 'nitro') unless File.exist?(ennio_path)
    pod 'EnnioCore', :path => ennio_path if File.exist?(ennio_path)
  end

`;

      // Insert before post_install block (most reliable location)
      const postInstallMatch = podfile.match(/(\n\s*)(post_install\s+do\s*\|)/);

      if (postInstallMatch) {
        podfile = podfile.replace(
          postInstallMatch[0],
          postInstallMatch[1] + ennioConfig + postInstallMatch[2]
        );
      } else {
        // Fallback: try to add before final 'end' of the target block
        const targetEndMatch = podfile.match(/(target\s+['"][^'"]+['"]\s+do[\s\S]+?)(\nend\s*$)/m);
        if (targetEndMatch) {
          podfile = podfile.replace(
            targetEndMatch[0],
            targetEndMatch[1] + '\n' + ennioConfig + targetEndMatch[2]
          );
        }
      }

      fs.writeFileSync(podfilePath, podfile);
      console.log('[Ennio] Added conditional pod to Podfile');

      return config;
    },
  ]);
}

function withEnnioAndroid(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const buildGradlePath = path.join(
        config.modRequest.platformProjectRoot,
        'app',
        'build.gradle'
      );

      if (!fs.existsSync(buildGradlePath)) {
        return config;
      }

      let buildGradle = fs.readFileSync(buildGradlePath, 'utf-8');

      // Check if already modified
      if (buildGradle.includes('// Ennio E2E Testing')) {
        return config;
      }

      // Add conditional dependency
      const ennioConfig = `
    // Ennio E2E Testing - conditionally included
    // Set ENNIO_ENABLED=false to disable
    if (findProperty("ENNIO_ENABLED") != "false") {
        implementation project(':ennio-nitro')
    }
`;

      // Find dependencies block and add inside
      const depsMatch = buildGradle.match(/(dependencies\s*\{)/);
      if (depsMatch) {
        buildGradle = buildGradle.replace(
          depsMatch[0],
          depsMatch[0] + ennioConfig
        );
      }

      fs.writeFileSync(buildGradlePath, buildGradle);
      console.log('[Ennio] Added conditional dependency to build.gradle');

      return config;
    },
  ]);
}

function withEnnio(config, options = {}) {
  // Check if disabled via env var
  if (process.env.ENNIO_ENABLED === '0' || process.env.ENNIO_ENABLED === 'false') {
    console.log('[Ennio] Disabled via ENNIO_ENABLED environment variable');
    return config;
  }

  // Check if disabled via plugin options
  if (options.enabled === false) {
    console.log('[Ennio] Disabled via plugin options');
    return config;
  }

  config = withEnnioIOS(config);
  config = withEnnioAndroid(config);

  return config;
}

module.exports = withEnnio;
