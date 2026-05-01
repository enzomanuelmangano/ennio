/**
 * Disable React Native autolinking for @tasto/nitro
 *
 * The @tasto/expo-plugin controls whether native code is included.
 * This allows conditional inclusion based on build type (dev/production).
 */
module.exports = {
  dependency: {
    platforms: {
      ios: null,     // Disable iOS autolinking
      android: null, // Disable Android autolinking
    },
  },
};
