#!/usr/bin/env ruby
# Add the EnnioXCTestRunner UI test target to example/ios/EnnioExample.xcodeproj.
# Idempotent: checks for an existing target with the same name and exits early.

require 'xcodeproj'
require 'fileutils'

PROJECT_PATH = ARGV[0] || File.expand_path('../example/ios/EnnioExample.xcodeproj', __dir__)
RUNNER_SOURCES = File.expand_path('../packages/xctest-runner/EnnioXCTestRunner', __dir__)
TARGET_NAME = 'EnnioXCTestRunner'
HOST_TARGET_NAME = 'EnnioExample'

unless File.directory?(PROJECT_PATH)
  abort "Xcode project not found: #{PROJECT_PATH} (run `expo prebuild` first)"
end

project = Xcodeproj::Project.open(PROJECT_PATH)
host_target = project.targets.find { |t| t.name == HOST_TARGET_NAME }
abort "Host target '#{HOST_TARGET_NAME}' not found in project" unless host_target

existing = project.targets.find { |t| t.name == TARGET_NAME }
if existing
  warn "[ennio] target '#{TARGET_NAME}' already present, skipping creation"
else
  warn "[ennio] adding UI test target '#{TARGET_NAME}'"
  test_target = project.new_target(:ui_test_bundle, TARGET_NAME, :ios, '15.1')

  # Wire the host application so the test bundle launches the user's app.
  test_target.build_configurations.each do |config|
    config.build_settings['PRODUCT_NAME'] = TARGET_NAME
    config.build_settings['TEST_TARGET_NAME'] = HOST_TARGET_NAME
    config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.ennio.xctestrunner'
    config.build_settings['SWIFT_VERSION'] = '5.0'
    config.build_settings['INFOPLIST_FILE'] = "../../packages/xctest-runner/EnnioXCTestRunner/Info.plist"
    config.build_settings['LD_RUNPATH_SEARCH_PATHS'] = [
      '$(inherited)',
      '@executable_path/Frameworks',
      '@loader_path/Frameworks',
    ]
    config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.1'
    config.build_settings['CODE_SIGN_STYLE'] = 'Automatic'
    config.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'
  end
end

target = project.targets.find { |t| t.name == TARGET_NAME }

# Always reapply build settings (idempotent).
target.build_configurations.each do |config|
  config.build_settings['PRODUCT_NAME'] = TARGET_NAME
  config.build_settings['TEST_TARGET_NAME'] = HOST_TARGET_NAME
  config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.ennio.xctestrunner'
  config.build_settings['SWIFT_VERSION'] = '5.0'
  config.build_settings['INFOPLIST_FILE'] = "../../packages/xctest-runner/EnnioXCTestRunner/Info.plist"
  config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.1'
  config.build_settings['CODE_SIGN_STYLE'] = 'Automatic'
  config.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'
end

# Make sure source files are referenced in the project. We use a relative
# path so the project file stays portable across machines.
runner_group = project.main_group.find_subpath(TARGET_NAME, true)
runner_group.set_source_tree('SOURCE_ROOT')
runner_group.path = '../../packages/xctest-runner/EnnioXCTestRunner'

%w[EnnioActionsTest.swift ActionServer.swift].each do |fname|
  abs = File.join(RUNNER_SOURCES, fname)
  abort "missing source: #{abs}" unless File.exist?(abs)
  ref = runner_group.files.find { |f| f.path == fname }
  unless ref
    ref = runner_group.new_reference(fname)
    ref.last_known_file_type = 'sourcecode.swift'
  end
  unless target.source_build_phase.files_references.include?(ref)
    target.add_file_references([ref])
  end
end

# Also expose Info.plist as a resource reference so users see it in Xcode.
plist_ref = runner_group.files.find { |f| f.path == 'Info.plist' }
runner_group.new_reference('Info.plist') unless plist_ref

# Mark the test target as a dependency-after-host so xcodebuild will build
# the host first when invoked with -scheme EnnioXCTestRunner.
unless target.dependencies.any? { |d| d.target == host_target }
  target.add_dependency(host_target)
end

project.save

# Generate a shared scheme so xcodebuild test-without-building can locate it.
shared_dir = File.join(PROJECT_PATH, 'xcshareddata', 'xcschemes')
FileUtils.mkdir_p(shared_dir)
scheme = Xcodeproj::XCScheme.new
scheme.add_test_target(target)
scheme.add_build_target(host_target)
scheme.set_launch_target(host_target)
scheme.save_as(PROJECT_PATH, TARGET_NAME, true)
warn "[ennio] wrote scheme #{TARGET_NAME}.xcscheme"

warn "[ennio] done"
