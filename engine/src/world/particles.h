// Particles2D simulation (deterministic, advanced by the fixed tick). A port of
// engine-web/core/particles.ts.
//
// engine-web stores particles in Float32Arrays, so every stored value is rounded to float. We use
// float storage and do the arithmetic in double exactly where the JS code does, so particle counts
// (which scripts can read as `particleCount`) match engine-web exactly.
#pragma once

#include <cstdint>
#include <vector>

#include "base/rng.h"

namespace dreamsy::world {

// The Particles2D props the simulation reads.
struct EmitterParams {
  int max_particles = 256;
  double direction = -90, spread = 45;  // degrees
  double speed = 120, speed_random = 0.3;
  double lifetime = 1, lifetime_random = 0.3;
  double emission_w = 0, emission_h = 0;
  double gravity_x = 0, gravity_y = 0;
  double damping = 0;
  double rate = 20;
  bool emitting = true;
};

class Emitter {
 public:
  explicit Emitter(uint32_t seed) : rng_(seed) {}

  // Emits `count` particles now (e:burst, or the continuous rate). (px, py) = world position,
  // rot_deg = world rotation in degrees.
  void emit(const EmitterParams& p, int count, double px, double py, double rot_deg);
  // One tick: age and move particles (dropping dead ones in order), then emit at `rate` while
  // `active` (visible) and emitting.
  void step(const EmitterParams& p, double dt, double px, double py, double rot_deg, bool active);
  void clear() {
    n_ = 0;
    acc_ = 0;
  }

  int count() const { return n_; }
  float x(int i) const { return x_[i]; }
  float y(int i) const { return y_[i]; }
  float age(int i) const { return age_[i]; }
  float life(int i) const { return life_[i]; }

 private:
  void ensure(int cap);

  int n_ = 0, cap_ = 0;
  std::vector<float> x_, y_, vx_, vy_, age_, life_;
  double acc_ = 0;  // fractional particles carried between ticks
  Rng rng_;
};

}  // namespace dreamsy::world
