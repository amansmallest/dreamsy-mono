#include "ui/toasts.h"

#include <utility>

namespace dreamsy::ui {

void ToastQueue::push(int64_t id, std::string text, double now, double seconds) {
  toasts_.push_back(Toast{id, std::move(text), now + seconds});
  if (toasts_.size() > kMaxToasts) toasts_.erase(toasts_.begin());
}

void ToastQueue::expire(double now) {
  std::erase_if(toasts_, [&](const Toast& t) { return !(t.until > now); });
}

}  // namespace dreamsy::ui
