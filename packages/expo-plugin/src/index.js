const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Expo config plugin for Ennio E2E testing.
 *
 * Default = OFF. Ennio's runtime embeds a network-listening
 * remote-control surface in the app process; including it in a
 * distribution build is a critical-severity security hole. The plugin
 * is therefore strictly opt-in:
 *
 *   ENNIO_ENABLED=1 bunx expo prebuild --clean      # iOS
 *   ENNIO_ENABLED=true ./gradlew assembleDebug       # Android
 *
 * Any other value — including unset — produces a build with zero Ennio
 * symbols. Production / App Store / Play Store builds MUST run without
 * this env var set.
 */

function withEnnioIOS(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile');

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
  # Ennio E2E Testing — opt-in only.
  # Ennio embeds a network-listening remote-control surface in the app
  # process; shipping it to production is a critical vulnerability. The
  # pod is included ONLY when ENNIO_ENABLED=1 is set at \`pod install\`
  # time. Any other value (including unset) excludes it entirely.
  if ENV['ENNIO_ENABLED'] == '1'
    # Try standard layout, monorepo (1 level up), and bun workspace
    # (2 levels up — apps/<app>/node_modules empty, root has hoisted dep).
    candidate_paths = [
      File.join(__dir__, '..', 'node_modules', '@ennio', 'core'),
      File.join(__dir__, '..', '..', 'node_modules', '@ennio', 'core'),
      File.join(__dir__, '..', '..', '..', 'node_modules', '@ennio', 'core'),
    ]
    ennio_path = candidate_paths.find { |p| File.exist?(p) }
    pod 'EnnioCore', :path => ennio_path if ennio_path
  end

`;

      // Insert before post_install block (most reliable location)
      const postInstallMatch = podfile.match(/(\n\s*)(post_install\s+do\s*\|)/);

      if (postInstallMatch) {
        podfile = podfile.replace(
          postInstallMatch[0],
          postInstallMatch[1] + ennioConfig + postInstallMatch[2],
        );
      } else {
        // Fallback: try to add before final 'end' of the target block
        const targetEndMatch = podfile.match(/(target\s+['"][^'"]+['"]\s+do[\s\S]+?)(\nend\s*$)/m);
        if (targetEndMatch) {
          podfile = podfile.replace(
            targetEndMatch[0],
            targetEndMatch[1] + '\n' + ennioConfig + targetEndMatch[2],
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
        'build.gradle',
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
    // Ennio E2E Testing — opt-in only.
    // Set ENNIO_ENABLED=true at build time to include. Any other value
    // (including unset) excludes the dependency entirely.
    if (findProperty("ENNIO_ENABLED") == "true") {
        implementation project(':ennio-core')
    }
`;

      // Find dependencies block and add inside
      const depsMatch = buildGradle.match(/(dependencies\s*\{)/);
      if (depsMatch) {
        buildGradle = buildGradle.replace(depsMatch[0], depsMatch[0] + ennioConfig);
      }

      fs.writeFileSync(buildGradlePath, buildGradle);
      console.log('[Ennio] Added conditional dependency to build.gradle');

      return config;
    },
  ]);
}

function withEnnio(config, options = {}) {
  // Default: OFF. Ennio embeds a remote-control surface; opt in
  // explicitly per build by setting ENNIO_ENABLED=1 (iOS) or =true
  // (Android) at prebuild time. Any other value — including unset —
  // skips the entire plugin so production builds carry zero Ennio
  // symbols.
  if (process.env.ENNIO_ENABLED !== '1' && process.env.ENNIO_ENABLED !== 'true') {
    console.log('[Ennio] Disabled (ENNIO_ENABLED is not set to 1/true)');
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
