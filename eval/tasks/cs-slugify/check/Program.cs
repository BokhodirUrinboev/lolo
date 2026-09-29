using Demo;

void Check(bool ok, string what) { if (!ok) { Console.Error.WriteLine("FAIL: " + what); Environment.Exit(1); } }

Check(TextUtils.Slugify("  Hello, World!  ") == "hello-world", "hello-world");
Check(TextUtils.Slugify("C# -- is   fun") == "c-is-fun", "c-is-fun");
Check(TextUtils.Slugify("Ünïcode 2026") == "ncode-2026", "drops non a-z");
Check(TextUtils.Slugify("") == "", "empty");
Console.WriteLine("OK");
