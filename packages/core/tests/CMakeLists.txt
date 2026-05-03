cmake_minimum_required(VERSION 3.14)
project(ennio_tests CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Enable debug logging for tests
add_compile_definitions(ENNIO_DEBUG=4)

# Fetch GoogleTest
include(FetchContent)
FetchContent_Declare(
  googletest
  URL https://github.com/google/googletest/archive/refs/tags/v1.14.0.zip
)
# For Windows: Prevent overriding the parent project's compiler/linker settings
set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(googletest)

# Source files under test (only self-contained files that don't need RN headers)
set(ENNIO_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/../cpp/SelectorParser.cpp
)

# Test sources
set(TEST_SOURCES
  SelectorParserTest.cpp
  ElementMatcherTest.cpp
)

# Include directories
include_directories(${CMAKE_CURRENT_SOURCE_DIR}/../cpp)

# Create test executable
add_executable(ennio_tests ${TEST_SOURCES} ${ENNIO_SOURCES})

# Link GoogleTest
target_link_libraries(ennio_tests
  GTest::gtest_main
)

# Enable testing
enable_testing()

# Register tests with CTest
include(GoogleTest)
gtest_discover_tests(ennio_tests)
