const { withDangerousMod, withXcodeProject } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Expo config plugin for Tasto E2E testing
 *
 * This plugin conditionally includes the @tasto/nitro native module.
 * By default, it's only included in non-production builds.
 *
 * Usage:
 *   // app.json - include in all builds
 *   ["@tasto/expo-plugin"]
 *
 *   // app.json - configure options
 *   ["@tasto/expo-plugin", { "enabled": true }]
 *
 * Set TASTO_ENABLED=0 environment variable to disable at prebuild time.
 */

function withTastoIOS(config) {
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
      if (podfile.includes('# Tasto E2E Testing')) {
        return config;
      }

      // Add conditional pod inclusion before post_install block
      // Support both standard and monorepo layouts
      const tastoConfig = `
  # Tasto E2E Testing - conditionally included
  # Set TASTO_ENABLED=0 to disable
  if ENV['TASTO_ENABLED'] != '0'
    # Try standard layout first, then monorepo layout
    tasto_path = File.join(__dir__, '..', 'node_modules', '@tasto', 'nitro')
    tasto_path = File.join(__dir__, '..', '..', 'node_modules', '@tasto', 'nitro') unless File.exist?(tasto_path)
    pod 'TastoNitro', :path => tasto_path if File.exist?(tasto_path)
  end

`;

      // Insert before post_install block (most reliable location)
      const postInstallMatch = podfile.match(/(\n\s*)(post_install\s+do\s*\|)/);

      if (postInstallMatch) {
        podfile = podfile.replace(
          postInstallMatch[0],
          postInstallMatch[1] + tastoConfig + postInstallMatch[2]
        );
      } else {
        // Fallback: try to add before final 'end' of the target block
        const targetEndMatch = podfile.match(/(target\s+['"][^'"]+['"]\s+do[\s\S]+?)(\nend\s*$)/m);
        if (targetEndMatch) {
          podfile = podfile.replace(
            targetEndMatch[0],
            targetEndMatch[1] + '\n' + tastoConfig + targetEndMatch[2]
          );
        }
      }

      fs.writeFileSync(podfilePath, podfile);
      console.log('[Tasto] Added conditional pod to Podfile');

      return config;
    },
  ]);
}

function withTastoAndroid(config) {
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
      if (buildGradle.includes('// Tasto E2E Testing')) {
        return config;
      }

      // Add conditional dependency
      const tastoConfig = `
    // Tasto E2E Testing - conditionally included
    // Set TASTO_ENABLED=false to disable
    if (findProperty("TASTO_ENABLED") != "false") {
        implementation project(':tasto-nitro')
    }
`;

      // Find dependencies block and add inside
      const depsMatch = buildGradle.match(/(dependencies\s*\{)/);
      if (depsMatch) {
        buildGradle = buildGradle.replace(
          depsMatch[0],
          depsMatch[0] + tastoConfig
        );
      }

      fs.writeFileSync(buildGradlePath, buildGradle);
      console.log('[Tasto] Added conditional dependency to build.gradle');

      return config;
    },
  ]);
}

function withTasto(config, options = {}) {
  // Check if disabled via env var
  if (process.env.TASTO_ENABLED === '0' || process.env.TASTO_ENABLED === 'false') {
    console.log('[Tasto] Disabled via TASTO_ENABLED environment variable');
    return config;
  }

  // Check if disabled via plugin options
  if (options.enabled === false) {
    console.log('[Tasto] Disabled via plugin options');
    return config;
  }

  config = withTastoIOS(config);
  config = withTastoAndroid(config);

  return config;
}

module.exports = withTasto;
