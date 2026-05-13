const { withDangerousMod, withInfoPlist } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Expo config plugin for Ennio E2E testing.
 *
 * Ennio is excluded from Release builds at the CocoaPods level: the
 * `pod 'EnnioCore'` line is annotated with `:configurations => [...]`,
 * so Xcode only compiles + links it for the listed configurations
 * (default: `Debug`). Release archives carry zero Ennio code,
 * symbols, or `+load` hooks by construction — no env var to
 * remember, no human discipline required.
 *
 * Options:
 *   - configurations  string[]  Xcode build configurations to link
 *                               EnnioCore into. Default ['Debug'].
 *   - showRibbon      boolean   Show the red diagonal E2E ribbon
 *                               overlay in builds where Ennio is
 *                               linked. Default false. Set true for
 *                               demos or QA artifact identification.
 *   - enabled         boolean   Skip the plugin entirely when false.
 *
 * Example:
 *   { "plugins": [["ennio-expo-plugin", {
 *       "configurations": ["Debug", "Staging"],
 *       "showRibbon": true
 *     }]] }
 */

function withEnnioPodfile(config, configurations) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile');

      if (!fs.existsSync(podfilePath)) {
        return config;
      }

      let podfile = fs.readFileSync(podfilePath, 'utf-8');

      if (podfile.includes('# Ennio E2E Testing')) {
        return config;
      }

      const configList = configurations.map((c) => `'${c}'`).join(', ');
      const ennioConfig = `
  # Ennio E2E Testing — Debug-configuration only.
  # CocoaPods compiles + links EnnioCore strictly for the listed
  # Xcode build configurations; Release archives never see it.
  # candidate_paths covers standard layout, monorepo (1 level up),
  # and bun-workspace hoisted layouts (2 levels up).
  candidate_paths = [
    File.join(__dir__, '..', 'node_modules', 'ennio'),
    File.join(__dir__, '..', '..', 'node_modules', 'ennio'),
    File.join(__dir__, '..', '..', '..', 'node_modules', 'ennio'),
  ]
  ennio_path = candidate_paths.find { |p| File.exist?(p) }
  pod 'EnnioCore', :path => ennio_path, :configurations => [${configList}] if ennio_path

`;

      const postInstallMatch = podfile.match(/(\n\s*)(post_install\s+do\s*\|)/);

      if (postInstallMatch) {
        podfile = podfile.replace(
          postInstallMatch[0],
          postInstallMatch[1] + ennioConfig + postInstallMatch[2],
        );
      } else {
        const targetEndMatch = podfile.match(/(target\s+['"][^'"]+['"]\s+do[\s\S]+?)(\nend\s*$)/m);
        if (targetEndMatch) {
          podfile = podfile.replace(
            targetEndMatch[0],
            targetEndMatch[1] + '\n' + ennioConfig + targetEndMatch[2],
          );
        }
      }

      fs.writeFileSync(podfilePath, podfile);
      console.log(`[Ennio] Added pod to Podfile (configurations: ${configList})`);

      return config;
    },
  ]);
}

function withEnnioInfoPlist(config, showRibbon) {
  // Plumbs runtime-toggleable options through Info.plist. Native side
  // reads `[NSBundle mainBundle].infoDictionary[@"ENNIORibbonEnabled"]`
  // at +load swizzle time. Key omitted (default) = ribbon off.
  return withInfoPlist(config, (config) => {
    if (showRibbon) {
      config.modResults.ENNIORibbonEnabled = true;
    } else {
      delete config.modResults.ENNIORibbonEnabled;
    }
    return config;
  });
}

function withEnnio(config, options = {}) {
  if (options.enabled === false) {
    console.log('[Ennio] Skipped via plugin options');
    return config;
  }

  const configurations =
    Array.isArray(options.configurations) && options.configurations.length > 0
      ? options.configurations
      : ['Debug'];

  const showRibbon = options.showRibbon === true;

  config = withEnnioPodfile(config, configurations);
  config = withEnnioInfoPlist(config, showRibbon);
  return config;
}

module.exports = withEnnio;
