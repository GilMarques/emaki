cmake_minimum_required(VERSION 3.18)
project(real_esrgan)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ── ncnn (prebuilt Vulkan shared lib, vendored from ncnn releases) ──
# ncnn packages per-ABI since ~2024: <abi>/lib/libncnn.so + <abi>/include/ncnn.
# The app only builds arm64-v8a (see build.gradle), so ANDROID_ABI selects it.
set(NCNN_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI})
set(NCNN_LIB ${NCNN_DIR}/lib/libncnn.so)
set(NCNN_INCLUDE_DIRS ${NCNN_DIR}/include/ncnn)

# ── system libs (image I/O is stb, header-only — no OpenCV/libwebp needed) ──
find_library(log-lib log)

add_library(real_esrgan SHARED
    plugin_bridge.cpp
    realsr.cpp                # vendored from RealSR-NCNN-Android
    realsr_preproc.comp.hex.h
    realsr_postproc.comp.hex.h
    realsr_preproc_tta.comp.hex.h
    realsr_postproc_tta.comp.hex.h
)

target_include_directories(real_esrgan PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${NCNN_INCLUDE_DIRS}
)

target_link_libraries(real_esrgan
    ${NCNN_LIB}
    ${log-lib}
    android
)

# Model weights ship in src/main/assets/models-realesrgan (packaged as Android
# assets) and are copied to the app cache at runtime by RealEsrganPlugin — ncnn
# can't open asset streams, and a POST_BUILD copy into the .so dir is unreliable.
