using System;

namespace Widget.Core;

public delegate int Transformer(int value);

public interface IStore
{
    void Save(string key);
}

public enum Color
{
    Red,
    Green
}

public struct Point
{
    public int X;
}

public record Money(decimal Amount);

public class Config : IStore
{
    public const int MaxSize = 100;
    private int _counter;
    public string Name { get; set; }

    public Config(string name)
    {
        Name = name;
    }

    public void Save(string key)
    {
    }

    public int Describe() => MaxSize;
}
