using Demo;

void Check(bool ok, string what) { if (!ok) { Console.Error.WriteLine("FAIL: " + what); Environment.Exit(1); } }

Check(Paging.PageCount(11, 5) == 3, "11/5 == 3");
Check(Paging.PageCount(10, 5) == 2, "10/5 == 2");
Check(Paging.PageCount(0, 5) == 0, "0/5 == 0");
Check(Paging.PageCount(1, 5) == 1, "1/5 == 1");
try { Paging.PageCount(10, 0); Check(false, "size 0 throws"); } catch (ArgumentOutOfRangeException) { }
Console.WriteLine("OK");
