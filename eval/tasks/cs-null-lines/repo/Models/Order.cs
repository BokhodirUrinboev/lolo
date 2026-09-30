namespace Shop.Models;

public class Order
{
    public string Id { get; set; } = "";
    public List<OrderLine>? Lines { get; set; }
}
