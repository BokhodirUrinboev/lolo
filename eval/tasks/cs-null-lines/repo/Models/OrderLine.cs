namespace Shop.Models;

public record OrderLine(string Sku, decimal Price, int Quantity);
