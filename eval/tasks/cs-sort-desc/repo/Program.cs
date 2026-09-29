using Sales;

var customers = new[] { new Customer("Ann", 120m), new Customer("Bob", 80m), new Customer("Cy", 200m) };
foreach (var c in Reports.TopCustomers(customers, 2)) Console.WriteLine($"{c.Name}: {c.Spend}");
