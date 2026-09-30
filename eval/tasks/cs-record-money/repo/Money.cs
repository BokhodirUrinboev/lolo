namespace Finance;

public class Money
{
    public Money(decimal amount, string currency)
    {
        Amount = amount;
        Currency = currency;
    }

    public decimal Amount { get; }
    public string Currency { get; }

    public Money Add(Money other)
    {
        if (other.Currency != Currency) throw new InvalidOperationException("currency mismatch");
        return new Money(Amount + other.Amount, Currency);
    }

    public override string ToString() => $"{Amount:0.00} {Currency}";
}
