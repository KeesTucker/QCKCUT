# The native media engine. Built both as part of the Flutter Linux runner and
# standalone, so it can be compiled and tested without starting the app.
cmake_minimum_required(VERSION 3.16)
project(qckcut_engine LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

find_package(PkgConfig REQUIRED)
pkg_check_modules(FFMPEG REQUIRED IMPORTED_TARGET
  libavcodec
  libavformat
  libavutil
  libswscale
  libswresample
  libavfilter
)

add_library(qckcut_engine SHARED
  src/engine.cpp
  src/source.cpp
  src/export.cpp
  src/sequence.cpp
)

target_include_directories(qckcut_engine PUBLIC include)
target_link_libraries(qckcut_engine PRIVATE PkgConfig::FFMPEG)

# Warnings on: this code hands raw buffers to Dart, so the compiler's opinion is
# worth having.
target_compile_options(qckcut_engine PRIVATE -Wall -Wextra -Wno-unused-parameter)

# A standalone exercise of the library, built only when this project is the top
# level one, so the Flutter build does not pay for it.
if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
  add_executable(qk_smoke test/smoke.cpp)
  target_link_libraries(qk_smoke PRIVATE qckcut_engine)

  add_executable(qk_seq test/seq.cpp)
  target_link_libraries(qk_seq PRIVATE qckcut_engine)
endif()
