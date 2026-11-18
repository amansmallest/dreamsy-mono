// Test runner entry point (doctest). Every *_test.cpp in tests/ links into one binary:
//   ctest --preset debug          or          build/debug/dreamsy-tests
#define DOCTEST_CONFIG_IMPLEMENT
#include "doctest.h"
#include "script/embedded_kits.h"

int main(int argc, char** argv) {
  dreamsy::script::use_embedded_kits();  // tests run games that require kits
  doctest::Context context(argc, argv);
  return context.run();
}
