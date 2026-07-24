#include <stdlib.h>

#define MAX_SIZE 100
#define SQUARE(x) ((x) * (x))

struct Point {
	int x;
	int y;
};

union Value {
	int i;
	float f;
};

enum Color { RED, GREEN, BLUE };

typedef struct Point PointT;

typedef int Counter;

int add(int a, int b) {
	return a + b;
}

char *make_label(int n) {
	(void)n;
	return NULL;
}

const char **matrix(void) {
	return NULL;
}
