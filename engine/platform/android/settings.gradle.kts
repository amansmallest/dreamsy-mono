// Android shell for dreamsy-player (engine/README.md "Phones"). No Java/Kotlin code: the app is a
// NativeActivity that loads libdreamsy-player.so, built from engine/CMakeLists.txt by the NDK.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "dreamsy-player"
include(":app")
