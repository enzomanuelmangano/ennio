require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name         = 'EnnioCore'
  s.version      = package['version']
  s.summary      = package['description']
  s.homepage     = package['repository']['url']
  s.license      = package['license']
  s.authors      = { 'Ennio' => 'hello@ennio.dev' }
  s.platforms    = { :ios => '17.0' }
  s.source       = { :git => package['repository']['url'], :tag => "ennio@#{s.version}" }

  # Pure ObjC + a tiny C++ socket primitive. No Fabric headers, no
  # nitrogen-generated bindings, no React Native private surface.
  s.source_files = [
    'cpp/**/*.{h,hpp,c,cpp}',
    'ios/bootstrap/**/*.{h,mm}',
    'ios/finders/**/*.{h,mm}',
    'ios/handlers/**/*.{h,mm}',
    'ios/observers/**/*.{h,mm}',
    'ios/ops/**/*.{h,mm}',
    'ios/PrivateAPI/**/*.{h,mm}',
    'native-shim/**/*.{h,m}',
  ]

  s.compiler_flags = '-fno-objc-arc-exceptions'

  s.pod_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    # Recursive `**` so the ios/ subfolder layout (bootstrap/, finders/,
    # observers/, ops/, handlers/) resolves a flat #import regardless
    # of which folder the importer lives in. Xcode expands `**` to
    # every descendant directory at build time.
    'HEADER_SEARCH_PATHS' => [
      '"$(PODS_TARGET_SRCROOT)/cpp"',
      '"$(PODS_TARGET_SRCROOT)/ios/**"',
    ].join(' ')
  }

  # CRITICAL: force linker to load all ObjC code so +load runs at attach.
  s.user_target_xcconfig = {
    'OTHER_LDFLAGS' => '-ObjC',
  }

  # Public Apple frameworks only. No React-Core, no React-Fabric, no
  # nitrogen autolinking.
  s.frameworks = 'UIKit', 'Foundation', 'QuartzCore', 'CoreGraphics', 'Security'
end
