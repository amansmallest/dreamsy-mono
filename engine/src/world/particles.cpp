#include "world/particles.h"

#include <algorithm>
#include <cmath>
#include <numbers>

namespace dreamsy::world {

void Emitter::ensure(int cap) {
  if (cap == cap_) return;
  for (std::vector<float>* a : {&x_, &y_, &vx_, &vy_, &age_, &life_}) a->resize(static_cast<size_t>(cap), 0.0f);
  cap_ = cap;
  n_ = std::min(n_, cap);
}

void Emitter::emit(const EmitterParams& p, int count, double px, double py, double rot_deg) {
  ensure(p.max_particles);
  constexpr double kPi = std::numbers::pi;
  const double dir = (p.direction + rot_deg) * kPi / 180;
  const double spread = p.spread * kPi / 180;
  for (int k = 0; k < count && n_ < cap_; ++k) {
    const size_t i = static_cast<size_t>(n_++);
    // Same call order as engine-web: the RNG sequence must match.
    const double a = dir + (rng_.next() - 0.5) * spread;
    const double v = p.speed * (1 - p.speed_random * rng_.next());
    x_[i] = static_cast<float>(px + (rng_.next() - 0.5) * p.emission_w);
    y_[i] = static_cast<float>(py + (rng_.next() - 0.5) * p.emission_h);
    vx_[i] = static_cast<float>(std::cos(a) * v);
    vy_[i] = static_cast<float>(std::sin(a) * v);
    age_[i] = 0;
    life_[i] = static_cast<float>(std::max(0.02, p.lifetime * (1 - p.lifetime_random * rng_.next())));
  }
}

void Emitter::step(const EmitterParams& p, double dt, double px, double py, double rot_deg, bool active) {
  ensure(p.max_particles);
  const double damp = std::max(0.0, 1 - p.damping * dt);
  int w = 0;
  for (int i = 0; i < n_; ++i) {
    const double age = static_cast<double>(age_[i]) + dt;
    if (age >= life_[i]) continue;
    const double vx = vx_[i] * damp + p.gravity_x * dt, vy = vy_[i] * damp + p.gravity_y * dt;
    x_[w] = static_cast<float>(x_[i] + vx * dt);
    y_[w] = static_cast<float>(y_[i] + vy * dt);
    vx_[w] = static_cast<float>(vx);
    vy_[w] = static_cast<float>(vy);
    age_[w] = static_cast<float>(age);
    life_[w] = life_[i];
    ++w;
  }
  n_ = w;
  if (active && p.emitting) {
    acc_ += p.rate * dt;
    const double k = std::floor(acc_);
    if (k > 0) {
      acc_ -= k;
      emit(p, static_cast<int>(k), px, py, rot_deg);
    }
  } else {
    acc_ = 0;
  }
}

}  // namespace dreamsy::world
