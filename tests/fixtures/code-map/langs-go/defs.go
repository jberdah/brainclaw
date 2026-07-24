package widget

import "fmt"

const MaxSize = 100

var counter int

type Config struct {
	Name string
	size int
}

type Store interface {
	Get(k string) (string, error)
	Put(k, v string) error
}

func New(name string) *Config {
	return &Config{Name: name}
}

func (c *Config) Describe() string {
	return fmt.Sprintf("%s/%d", c.Name, c.size)
}
