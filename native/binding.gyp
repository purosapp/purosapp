{
  "targets": [
    {
      "target_name": "puros_audio",
      "sources": [
        "src/addon.cpp",
        "src/AudioEngine.cpp",
        "src/DSPPipeline.cpp",
        "src/Resampler.cpp",
        "src/FirFilter.cpp",
        "src/DsdModulator.cpp",
        "src/PluginRack.mm",
        "vendor/vst3sdk-interfaces/pluginterfaces/base/coreiids.cpp",
        "vendor/vst3sdk-interfaces/public.sdk/source/vst/vstinitiids.cpp",
        "src/NowPlayingBridge.mm"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "vendor/vst3sdk-interfaces",
        "../build/audio/soxr/include"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "conditions": [
        ["OS=='mac'", {
          "link_settings": {
            "libraries": [
              "-framework CoreAudio",
              "-framework AudioToolbox",
              "-framework Accelerate",
              "-framework CoreFoundation",
              "-framework MediaPlayer",
              "-framework AppKit",
              "-framework Foundation",
              "<(module_root_dir)/../build/audio/soxr/lib/libsoxr.0.dylib"
            ]
          },
          # libsoxr (LGPL-2.1) ships as its own dylib next to the addon.
          "copies": [
            {
              "destination": "<(PRODUCT_DIR)",
              "files": [
                "../build/audio/soxr/lib/libsoxr.0.dylib",
                "../build/audio/soxr/SOXR-COPYING.LGPL"
              ]
            }
          ],
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "12.0",
            "OTHER_LDFLAGS": ["-Wl,-rpath,@loader_path"]
          }
        }]
      ]
    }
  ]
}
