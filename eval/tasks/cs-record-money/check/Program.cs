using Finance;

void Check(bool ok, string what) { if (!ok) { Console.Error.WriteLine("FAIL: " + what); Environment.Exit(1); } }

Check(new Money(5m, "USD") == new Money(5m, "USD"), "==");
Check(new Money(5m, "USD").Equals(new Money(5m, "USD")), "Equals");
Check(new Money(5m, "USD") != new Money(5m, "EUR"), "!= by currency");
Check(new Money(5m, "USD") != new Money(6m, "USD"), "!= by amount");
Check(new HashSet<Money> { new(1m, "USD"), new(1m, "USD"), new(2m, "USD") }.Count == 2, "set keys");
Check(new Money(1m, "USD").Add(new Money(2m, "USD")) == new Money(3m, "USD"), "Add");
Check(new Money(3m, "EUR").ToString() == "3.00 EUR", "ToString");
Console.WriteLine("OK");
