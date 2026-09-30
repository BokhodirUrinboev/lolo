using Billing;

void Check(bool ok, string what) { if (!ok) { Console.Error.WriteLine("FAIL: " + what); Environment.Exit(1); } }

Check(TaxCalculator.ComputeTax(10m, 0.2m) == 2m, "ComputeTax");
Check(new Checkout(0.1m).Gross(20m) == 22m, "Gross");
Check(new Checkout(0.25m).Receipt(4m) == "net 4.00, tax 1.00", "Receipt");
Console.WriteLine("OK");
