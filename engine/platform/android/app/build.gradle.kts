plugins {
    id("com.android.application")
}

android {
    namespace = "com.dreamsy.player"
    compileSdk = 35
    ndkVersion = "27.2.12479018" // NDK r27c (LTS)

    defaultConfig {
        applicationId = "com.dreamsy.player"
        minSdk = 26 // Android 8.0; GLES3 is everywhere from here
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        ndk {
            abiFilters += "arm64-v8a"
        }
        externalNativeBuild {
            cmake {
                // Same switches as the android-arm64 CMake preset. Static libc++ keeps it to one .so.
                arguments += listOf("-DDREAMSY_BUILD_TESTS=OFF", "-DANDROID_STL=c++_static")
                targets += "dreamsy-player"
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("../../../CMakeLists.txt") // engine/CMakeLists.txt
            version = "3.22.1"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Signed with the debug key so `assembleRelease` installs; use a real key for the store.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}
