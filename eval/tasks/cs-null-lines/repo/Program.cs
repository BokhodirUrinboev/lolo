using Shop.Models;
using Shop.Services;

var order = new Order { Id = "A1", Lines = [new OrderLine("pen", 1.5m, 2)] };
Console.WriteLine($"{order.Id}: {new OrderService().Total(order)}");
