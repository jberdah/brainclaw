#include <string>

#define MAX_SIZE 100
#define SQUARE(x) ((x) * (x))

namespace widget {

typedef unsigned int handle_t;
using Id = int;

enum Color { Red, Green };
enum class Mode { Fast, Slow };

struct Point {
  int x;
  int y;
};

class Config {
public:
  int size() const { return size_; }
  void reset() { size_ = 0; }

private:
  int size_;
};

int freefn(int a) { return a; }

} // namespace widget
