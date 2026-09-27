#include <jni.h>
#include <android/asset_manager_jni.h>
#include <android/bitmap.h>
#include <opencv2/core/core.hpp>
#include <opencv2/imgproc/imgproc.hpp>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

#include "ncnn/cpu.h"
#include "ncnn/net.h"
#include "ncnn/platform.h"
#include "ppocrv5.h"
#include "ppocrv5_dict.h"

namespace {

std::mutex g_ocr_mutex;
PPOCRv5 g_ocr;
bool g_ocr_loaded = false;
int g_ocr_load_code = 0;

const char* kDetParam = "jcc_ocr_models/PP_OCRv5_mobile_det.ncnn.param";
const char* kDetModel = "jcc_ocr_models/PP_OCRv5_mobile_det.ncnn.bin";
const char* kRecParam = "jcc_ocr_models/PP_OCRv5_mobile_rec.ncnn.param";
const char* kRecModel = "jcc_ocr_models/PP_OCRv5_mobile_rec.ncnn.bin";

std::string JsonEscape(const std::string& value) {
    std::ostringstream out;
    for (unsigned char c : value) {
        switch (c) {
            case '"': out << "\\\""; break;
            case '\\': out << "\\\\"; break;
            case '\b': out << "\\b"; break;
            case '\f': out << "\\f"; break;
            case '\n': out << "\\n"; break;
            case '\r': out << "\\r"; break;
            case '\t': out << "\\t"; break;
            default:
                if (c < 0x20) {
                    const char* hex = "0123456789abcdef";
                    out << "\\u00" << hex[(c >> 4) & 0x0f] << hex[c & 0x0f];
                } else {
                    out << static_cast<char>(c);
                }
        }
    }
    return out.str();
}

std::string TextOf(const Object& object) {
    std::string text;
    for (const Character& ch : object.text) {
        if (ch.id < 0 || ch.id >= character_dict_size) {
            if (!text.empty() && text.back() != ' ') text += " ";
            continue;
        }
        text += character_dict[ch.id];
    }
    return text;
}

bool EnsureOcrLoaded(JNIEnv* env, jobject asset_manager) {
    std::lock_guard<std::mutex> guard(g_ocr_mutex);
    if (g_ocr_loaded) return true;
    if (!asset_manager) {
        g_ocr_load_code = -100;
        return false;
    }
    AAssetManager* mgr = AAssetManager_fromJava(env, asset_manager);
    if (!mgr) {
        g_ocr_load_code = -101;
        return false;
    }
    g_ocr.set_target_size(640);
    g_ocr_load_code = g_ocr.load(mgr, kDetParam, kDetModel, kRecParam, kRecModel, false, false);
    g_ocr_loaded = (g_ocr_load_code == 0);
    return g_ocr_loaded;
}

std::string RecognizeBitmap(JNIEnv* env, jobject asset_manager, jobject bitmap) {
    if (!EnsureOcrLoaded(env, asset_manager)) {
        std::ostringstream out;
        out << "{\"engine\":\"jcc_native_ppocrv5_ncnn_mobile\",\"available\":false,\"load_code\":"
            << g_ocr_load_code << ",\"blocks\":[]}";
        return out.str();
    }

    AndroidBitmapInfo info{};
    if (AndroidBitmap_getInfo(env, bitmap, &info) != ANDROID_BITMAP_RESULT_SUCCESS ||
        info.format != ANDROID_BITMAP_FORMAT_RGBA_8888 ||
        info.width == 0 ||
        info.height == 0) {
        return "{\"engine\":\"jcc_native_ppocrv5_ncnn_mobile\",\"available\":true,\"error\":\"unsupported_bitmap\",\"blocks\":[]}";
    }

    void* pixels = nullptr;
    if (AndroidBitmap_lockPixels(env, bitmap, &pixels) != ANDROID_BITMAP_RESULT_SUCCESS || !pixels) {
        return "{\"engine\":\"jcc_native_ppocrv5_ncnn_mobile\",\"available\":true,\"error\":\"lock_pixels_failed\",\"blocks\":[]}";
    }

    cv::Mat rgba(static_cast<int>(info.height), static_cast<int>(info.width), CV_8UC4, pixels, info.stride);
    cv::Mat rgb;
    cv::cvtColor(rgba, rgb, cv::COLOR_RGBA2RGB);
    AndroidBitmap_unlockPixels(env, bitmap);

    std::vector<Object> objects;
    {
        std::lock_guard<std::mutex> guard(g_ocr_mutex);
        g_ocr.detect_and_recognize(rgb, objects);
    }

    std::ostringstream out;
    out << "{\"engine\":\"jcc_native_ppocrv5_ncnn_mobile\",\"available\":true,\"text_recognition_active\":true,"
        << "\"block_count\":" << objects.size() << ",\"blocks\":[";
    for (size_t i = 0; i < objects.size(); ++i) {
        const Object& object = objects[i];
        if (i > 0) out << ",";
        out << "{\"text\":\"" << JsonEscape(TextOf(object)) << "\","
            << "\"confidence\":" << object.prob << ","
            << "\"orientation\":" << object.orientation << ","
            << "\"center\":{\"x\":" << object.rrect.center.x << ",\"y\":" << object.rrect.center.y << "},"
            << "\"size\":{\"w\":" << object.rrect.size.width << ",\"h\":" << object.rrect.size.height << "},"
            << "\"angle\":" << object.rrect.angle << "}";
    }
    out << "]}";
    return out.str();
}

} // namespace

extern "C" JNIEXPORT jstring JNICALL
Java_ai_codex_jcccompanion_NativeOcrBridge_nativeVersion(JNIEnv* env, jclass) {
    std::string version = std::string("jcc-ocr-native-0.3.0+ppocrv5-ncnn-") + NCNN_VERSION_STRING;
    return env->NewStringUTF(version.c_str());
}

extern "C" JNIEXPORT jboolean JNICALL
Java_ai_codex_jcccompanion_NativeOcrBridge_nativeCanRun(JNIEnv* env, jclass, jobject asset_manager) {
    ncnn::Net net;
    net.opt.num_threads = ncnn::get_cpu_count() > 0 ? 1 : 0;
    if (net.opt.num_threads <= 0) return JNI_FALSE;
    return EnsureOcrLoaded(env, asset_manager) ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jint JNICALL
Java_ai_codex_jcccompanion_NativeOcrBridge_nativeLoadCode(JNIEnv*, jclass) {
    return g_ocr_load_code;
}

extern "C" JNIEXPORT jstring JNICALL
Java_ai_codex_jcccompanion_NativeOcrBridge_nativeRecognizeBitmap(JNIEnv* env, jclass, jobject asset_manager, jobject bitmap) {
    std::string result = RecognizeBitmap(env, asset_manager, bitmap);
    return env->NewStringUTF(result.c_str());
}
