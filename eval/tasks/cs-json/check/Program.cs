using People;

void Check(bool ok, string what) { if (!ok) { Console.Error.WriteLine("FAIL: " + what); Environment.Exit(1); } }

Check(new Person("Ann", 30).ToJson() == "{\"name\":\"Ann\",\"age\":30}", "Ann");
Check(new Person("Bo", 7).ToJson() == "{\"name\":\"Bo\",\"age\":7}", "Bo");
Console.WriteLine("OK");
