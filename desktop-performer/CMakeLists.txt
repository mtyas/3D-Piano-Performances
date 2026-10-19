cmake_minimum_required(VERSION 3.22)
project(PerformerAudio VERSION 0.1.0 LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_OSX_DEPLOYMENT_TARGET 12.0 CACHE STRING "Minimum macOS")
add_subdirectory(vendor/JUCE-8.0.12 JUCE EXCLUDE_FROM_ALL)
juce_add_gui_app(PerformerAudio PRODUCT_NAME "Performer Audio Engine"
    BUNDLE_ID "org.pianoperformances.audio" MICROPHONE_PERMISSION_ENABLED TRUE
    MICROPHONE_PERMISSION_TEXT "Use your selected microphone in the performer mixer.")
juce_generate_juce_header(PerformerAudio)
target_sources(PerformerAudio PRIVATE native/Main.cpp)
target_compile_definitions(PerformerAudio PRIVATE JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0
    JUCE_PLUGINHOST_VST3=1 JUCE_DISPLAY_SPLASH_SCREEN=0)
if(APPLE)
    target_compile_definitions(PerformerAudio PRIVATE JUCE_PLUGINHOST_AU=1)
endif()
if(WIN32)
    # JUCE 8 bundles the ASIO interface headers (see its ASIO LICENSE.txt).
    target_compile_definitions(PerformerAudio PRIVATE JUCE_ASIO=1 JUCE_WASAPI=1 JUCE_DIRECTSOUND=1)
endif()
target_link_libraries(PerformerAudio PRIVATE juce::juce_audio_utils juce::juce_audio_processors
    juce::juce_recommended_config_flags)
