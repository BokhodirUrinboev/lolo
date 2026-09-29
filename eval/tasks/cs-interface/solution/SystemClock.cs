namespace Greetings;

public class SystemClock : IClock
{
    public DateTime Now => DateTime.Now;
}
