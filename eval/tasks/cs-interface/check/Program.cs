using Greetings;

void Check(bool ok, string what) { if (!ok) { Console.Error.WriteLine("FAIL: " + what); Environment.Exit(1); } }

Check(new Greeter(new FixedClock(new DateTime(2026, 1, 1, 9, 0, 0))).Greet("Ann") == "Good morning, Ann", "morning");
Check(new Greeter(new FixedClock(new DateTime(2026, 1, 1, 15, 0, 0))).Greet("Bo") == "Good afternoon, Bo", "afternoon");
IClock system = new SystemClock();
Check(system.Now.Year >= 2024, "SystemClock is an IClock");
Console.WriteLine("OK");

class FixedClock(DateTime now) : IClock
{
    public DateTime Now => now;
}
