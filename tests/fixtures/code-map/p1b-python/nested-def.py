def outer():
    def inner():
        return 1

    return inner
