namespace Billing;

public static class TaxCalculator
{
    public static decimal CalcTax(decimal net, decimal rate) => Math.Round(net * rate, 2);
}
