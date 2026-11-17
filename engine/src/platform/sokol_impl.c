// The one translation unit that compiles the sokol implementations.
// The graphics backend (SOKOL_METAL / SOKOL_GLES3 / SOKOL_GLCORE) is set by CMake.
// On Apple platforms this file is compiled through sokol_impl.m (Objective-C is required there).
#define SOKOL_IMPL
#include "sokol_log.h"
#include "sokol_app.h"
#include "sokol_gfx.h"
#include "sokol_glue.h"
#include "sokol_time.h"
#include "util/sokol_gl.h"
