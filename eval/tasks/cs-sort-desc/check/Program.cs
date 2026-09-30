using Sales;

void Check(bool ok, string what) { if (!ok) { Console.Error.WriteLine("FAIL: " + what); Environment.Exit(1); } }

var list = new[] { new Customer("Dee", 50m), new Customer("Bob", 200m), new Customer("Ann", 200m), new Customer("Cy", 120m), new Customer("Eve", 10m) };
var top = Reports.TopCustomers(list, 3).Select(c => c.Name).ToArray();
Check(string.Join(",", top) == "Ann,Bob,Cy", "top 3 is Ann,Bob,Cy but was " + string.Join(",", top));
Check(Reports.TopCustomers(list, 0).Count == 0, "n = 0");
Check(Reports.TopCustomers(list, 10).Count == 5, "n > count");
Check(Reports.TotalSpend(list) == 580m, "total");
Console.WriteLine("OK");
