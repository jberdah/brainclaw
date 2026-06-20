package com.example.types;

interface Service {
    void run();
    int total();
}

enum Color {
    RED, GREEN, BLUE;

    public boolean isPrimary() {
        return this != GREEN;
    }
}

@interface MyAnnotation {
    String value() default "";
    int count();
}

record Point(int x, int y) {
    int sum() {
        return x + y;
    }
}
