namespace Sales;

public record Customer(string Name, decimal Spend);

public static class Reports
{
    /// <summary>The n customers who spent the most.</summary>
    public static List<Customer> TopCustomers(IEnumerable<Customer> customers, int n) =>
        customers.OrderBy(c => c.Spend).Take(n).ToList();

    public static decimal TotalSpend(IEnumerable<Customer> customers) => customers.Sum(c => c.Spend);
}
