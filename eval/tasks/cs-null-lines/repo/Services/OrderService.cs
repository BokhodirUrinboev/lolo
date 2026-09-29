using Shop.Models;

namespace Shop.Services;

public class OrderService
{
    public decimal Total(Order order) => order.Lines.Sum(l => l.Price * l.Quantity);

    public int ItemCount(Order order) => order.Lines?.Sum(l => l.Quantity) ?? 0;
}
