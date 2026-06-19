class Widget:
    def __init__(self, size):
        self.size = size

    def render(self):
        return self.size

    @property
    def area(self):
        return self.size * self.size

    @staticmethod
    def make():
        return Widget(0)

    @classmethod
    def from_size(cls, size):
        return cls(size)
