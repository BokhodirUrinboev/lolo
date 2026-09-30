namespace Billing;

public class Checkout
{
    private readonly decimal _rate;

    public Checkout(decimal rate) => _rate = rate;

    public decimal Gross(decimal net) => net + TaxCalculator.ComputeTax(net, _rate);

    public string Receipt(decimal net) => $"net {net:0.00}, tax {TaxCalculator.ComputeTax(net, _rate):0.00}";
}
