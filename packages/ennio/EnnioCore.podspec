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
  s.source       = { :git => package['repository']['url'], :tag => "v#{s.version}" }

  # Pure ObjC + a tiny C++ socket primitive. No Fabric headers, no
  # nitrogen-generated bindings, no React Native private surface.
  s.source_files = [
    'cpp/**/*.{h,hpp,c,cpp}',
    'ios/**/*.{h,hpp,mm,m}',
  ]

  s.compiler_flags = '-fno-objc-arc-exceptions'

  s.pod_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'HEADER_SEARCH_PATHS' => [
      '"$(PODS_TARGET_SRCROOT)/cpp"',
      '"$(PODS_TARGET_SRCROOT)/ios"',
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
