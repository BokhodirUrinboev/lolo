using Billing;

var checkout = new Checkout(0.2m);
Console.WriteLine(checkout.Receipt(10m));
Console.WriteLine(TaxCalculator.CalcTax(5m, 0.1m));
