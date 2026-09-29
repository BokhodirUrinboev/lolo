namespace Finance;

public record Money(decimal Amount, string Currency)
{
    public Money Add(Money other)
    {
        if (other.Currency != Currency) throw new InvalidOperationException("currency mismatch");
        return new Money(Amount + other.Amount, Currency);
    }

    public override string ToString() => $"{Amount:0.00} {Currency}";
}
