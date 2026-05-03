cmake_minimum_required(VERSION 3.22)
project(EnnioCore)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Find packages
find_package(ReactAndroid REQUIRED CONFIG)
find_package(fbjni REQUIRED CONFIG)
find_package(NitroModules REQUIRED CONFIG)

# Collect source files
file(GLOB_RECURSE CPP_SOURCES
    "../cpp/*.cpp"
    "../nitrogen/generated/android/*.cpp"
    "../nitrogen/generated/shared/*.cpp"
)

# Create library
add_library(EnnioCore SHARED ${CPP_SOURCES})

target_include_directories(EnnioCore PRIVATE
    ../cpp
    ../nitrogen/generated/android
    ../nitrogen/generated/shared
)

target_link_libraries(EnnioCore
    ReactAndroid::react_nativemodule_core
    ReactAndroid::runtimeexecutor
    ReactAndroid::fabricjni
    ReactAndroid::react_render_core
    ReactAndroid::react_render_uimanager
    ReactAndroid::react_render_scheduler
    ReactAndroid::react_debug
    ReactAndroid::react_render_componentregistry
    ReactAndroid::jsi
    fbjni::fbjni
    NitroModules::NitroModules
)
