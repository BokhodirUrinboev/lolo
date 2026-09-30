namespace Greetings;

public class Greeter
{
    private readonly SystemClock _clock;

    public Greeter(SystemClock clock) => _clock = clock;

    public string Greet(string name)
    {
        var hour = _clock.Now.Hour;
        var part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
        return $"Good {part}, {name}";
    }
}
