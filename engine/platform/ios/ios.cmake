# iOS app bundle for dreamsy-player (docs/engine.md §14.7). Included from engine/CMakeLists.txt when
# CMAKE_SYSTEM_NAME is iOS (presets ios-sim and ios-device; see engine/README.md "Phones").
#
# Luau runs in interpreter mode on iOS (no JIT: Luau.CodeGen is never linked), as on every target.

set(DREAMSY_IOS_BUNDLE_ID "com.dreamsy.player" CACHE STRING
    "iOS bundle identifier. Free Apple IDs need one nobody else has used, e.g. com.<yourname>.dreamsy")
set(DREAMSY_IOS_TEAM_ID "" CACHE STRING
    "Apple development team ID for device builds (Xcode > Settings > Accounts); empty = pick it in Xcode")

function(dreamsy_ios_app target)
  if(CMAKE_OSX_SYSROOT MATCHES "[Ss]imulator")
    set(DREAMSY_IOS_PLATFORM "iPhoneSimulator")
  else()
    set(DREAMSY_IOS_PLATFORM "iPhoneOS")
  endif()
  # configure_file fills @DREAMSY_IOS_PLATFORM@ / @CMAKE_OSX_DEPLOYMENT_TARGET@; CMake fills the
  # ${MACOSX_BUNDLE_*} fields from the target properties below when it builds the bundle.
  set(plist ${CMAKE_CURRENT_BINARY_DIR}/${target}-Info.plist.in)
  configure_file(${CMAKE_CURRENT_SOURCE_DIR}/platform/ios/Info.plist.in ${plist} @ONLY)

  set_target_properties(${target} PROPERTIES
    MACOSX_BUNDLE TRUE
    MACOSX_BUNDLE_INFO_PLIST ${plist}
    MACOSX_BUNDLE_BUNDLE_NAME "Dreamsy"
    MACOSX_BUNDLE_GUI_IDENTIFIER ${DREAMSY_IOS_BUNDLE_ID}
    MACOSX_BUNDLE_BUNDLE_VERSION "1"
    MACOSX_BUNDLE_SHORT_VERSION_STRING "0.1.0"
    OUTPUT_NAME "Dreamsy"
    XCODE_ATTRIBUTE_PRODUCT_BUNDLE_IDENTIFIER ${DREAMSY_IOS_BUNDLE_ID}
    XCODE_ATTRIBUTE_TARGETED_DEVICE_FAMILY "1,2"
    XCODE_ATTRIBUTE_CODE_SIGN_STYLE "Automatic"
    XCODE_ATTRIBUTE_CODE_SIGN_IDENTITY "Apple Development"
    XCODE_ATTRIBUTE_DEVELOPMENT_TEAM "${DREAMSY_IOS_TEAM_ID}")
endfunction()
