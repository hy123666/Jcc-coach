cmake_minimum_required(VERSION 3.22.1)

project(jcc_ocr LANGUAGES CXX)

set(REPO_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../../../..")
set(NCNN_ROOT "${REPO_ROOT}/.omx/third_party/ncnn/ncnn-20260526-android/ncnn-20260526-android/${ANDROID_ABI}")
set(OpenCV_DIR "${REPO_ROOT}/.omx/third_party/opencv-mobile/opencv-mobile-4.13.0-android/sdk/native/jni")
file(GLOB NDK_CLANG_LINUX_DIRS "${ANDROID_NDK}/toolchains/llvm/prebuilt/windows-x86_64/lib/clang/*/lib/linux")
list(SORT NDK_CLANG_LINUX_DIRS)
list(GET NDK_CLANG_LINUX_DIRS -1 NDK_LLVM_ROOT)

if(NOT EXISTS "${NCNN_ROOT}/lib/libncnn.a")
    message(FATAL_ERROR "Missing ncnn Android prebuilt for ${ANDROID_ABI}: ${NCNN_ROOT}")
endif()

if(NOT EXISTS "${OpenCV_DIR}/OpenCVConfig.cmake")
    message(FATAL_ERROR "Missing opencv-mobile Android package: ${OpenCV_DIR}")
endif()

find_package(OpenCV REQUIRED core imgproc)

if("${ANDROID_ABI}" STREQUAL "arm64-v8a")
    set(OMP_ABI "aarch64")
elseif("${ANDROID_ABI}" STREQUAL "x86_64")
    set(OMP_ABI "x86_64")
else()
    message(FATAL_ERROR "Unsupported OCR ABI: ${ANDROID_ABI}")
endif()

add_library(ncnn STATIC IMPORTED)
set_target_properties(ncnn PROPERTIES
        IMPORTED_LOCATION "${NCNN_ROOT}/lib/libncnn.a"
        INTERFACE_INCLUDE_DIRECTORIES "${NCNN_ROOT}/include")

add_library(omp STATIC IMPORTED)
set_target_properties(omp PROPERTIES
        IMPORTED_LOCATION "${NDK_LLVM_ROOT}/${OMP_ABI}/libomp.a")

add_library(jcc_ocr SHARED
        jcc_ocr.cpp
        ppocrv5/ppocrv5.cpp)

target_include_directories(jcc_ocr PRIVATE
        ppocrv5
        ${OpenCV_INCLUDE_DIRS})

target_link_libraries(jcc_ocr ncnn ${OpenCV_LIBS} omp android log jnigraphics)
