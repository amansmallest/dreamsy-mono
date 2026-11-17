// The one translation unit that compiles the single-header image and font libraries
// (stb_image, stb_rect_pack, stb_truetype, nanosvg). Built as its own CMake target with
// warnings off: this is vendored code (third_party/), not ours.
//
// The settings here are shared with the code that uses them (image.cpp, atlas.cpp, font.cpp):
// they include the same headers without the *_IMPLEMENTATION defines.
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// stb_image: PNG and JPEG from memory only. Packages are untrusted, so dimensions are capped
// (must match kMaxImageSide in image.h).
#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#define STBI_ONLY_JPEG
#define STBI_NO_STDIO
#define STBI_NO_LINEAR
#define STBI_NO_HDR
#define STBI_MAX_DIMENSIONS 4096
#include "stb_image.h"

#define STB_RECT_PACK_IMPLEMENTATION
#include "stb_rect_pack.h"

#define STB_TRUETYPE_IMPLEMENTATION
#include "stb_truetype.h"

#define NANOSVG_IMPLEMENTATION
#include "nanosvg.h"
#define NANOSVGRAST_IMPLEMENTATION
#include "nanosvgrast.h"
