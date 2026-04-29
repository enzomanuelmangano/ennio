require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
nitro = JSON.parse(File.read(File.join(__dir__, 'nitro.json')))

folly_compiler_flags = '-DFOLLY_NO_CONFIG -DFOLLY_MOBILE=1 -DFOLLY_USE_LIBCPP=1 -DFOLLY_CFG_NO_COROUTINES=1 -DFOLLY_HAVE_CLOCK_GETTIME=1'

Pod::Spec.new do |s|
  s.name         = 'TastoNitro'
  s.version      = package['version']
  s.summary      = package['description']
  s.homepage     = package['repository']['url']
  s.license      = package['license']
  s.authors      = { 'Tasto' => 'hello@tasto.dev' }
  s.platforms    = { :ios => '13.0', :tvos => '13.0' }
  s.source       = { :git => package['repository']['url'], :tag => "v#{s.version}" }

  s.source_files = [
    'cpp/**/*.{h,hpp,c,cpp}',
    'nitrogen/generated/ios/**/*.{h,hpp,c,cpp,m,mm}',
    'nitrogen/generated/shared/**/*.{h,hpp,c,cpp}'
  ]

  s.compiler_flags = folly_compiler_flags

  s.pod_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) FOLLY_NO_CONFIG=1',
    'HEADER_SEARCH_PATHS' => [
      '"$(PODS_ROOT)/boost"',
      '"$(PODS_ROOT)/RCT-Folly"',
      '"$(PODS_ROOT)/DoubleConversion"',
      '"$(PODS_ROOT)/Headers/Private/React-Core"',
      '"$(PODS_ROOT)/Headers/Public/React-Core"',
      '"$(PODS_ROOT)/Headers/Private/React-Fabric"',
      '"$(PODS_ROOT)/Headers/Public/React-Fabric"',
      '"$(PODS_ROOT)/Headers/Private/React-graphics"',
      '"$(PODS_ROOT)/Headers/Public/React-graphics"',
      '"$(PODS_ROOT)/Headers/Private/Yoga"',
    ].join(' ')
  }

  s.dependency 'NitroModules', '>= 0.18.0'
  s.dependency 'React-Core'
  s.dependency 'RCT-Folly'
  s.dependency 'React-Fabric'
  s.dependency 'React-RCTFabric'
  s.dependency 'React-graphics'

  s.frameworks = 'Security'
end
