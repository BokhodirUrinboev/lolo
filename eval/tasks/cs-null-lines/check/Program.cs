using Shop.Models;
using Shop.Services;

void Check(bool ok, string what) { if (!ok) { Console.Error.WriteLine("FAIL: " + what); Environment.Exit(1); } }

var svc = new OrderService();
Check(svc.Total(new Order { Id = "n", Lines = null }) == 0m, "null lines: total 0");
Check(svc.Total(new Order { Id = "e", Lines = [] }) == 0m, "no lines: total 0");
Check(svc.Total(new Order { Id = "t", Lines = [new OrderLine("a", 2.5m, 2), new OrderLine("b", 1m, 3)] }) == 8m, "2.5*2 + 1*3");
Check(svc.ItemCount(new Order { Id = "n", Lines = null }) == 0, "item count");
Console.WriteLine("OK");
