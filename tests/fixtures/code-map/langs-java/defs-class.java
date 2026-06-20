package com.example.app;

class App implements Service {
    private int count;
    public static final String NAME = "app";

    public App(int count) {
        this.count = count;
    }

    public void run() {
        System.out.println(count);
    }

    private int total() {
        return count;
    }

    static class Inner {
        void helper() {}
    }
}
