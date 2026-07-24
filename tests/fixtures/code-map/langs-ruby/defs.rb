require 'set'

MAX_SIZE = 100

module Widget
  VERSION = "1.0"

  class Config
    def initialize(name)
      @name = name
    end

    def describe
      @name
    end

    def self.build(name)
      new(name)
    end
  end

  def helper
    VERSION
  end
end

def top_level_fn(a)
  a + 1
end
