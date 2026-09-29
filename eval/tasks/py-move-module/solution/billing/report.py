from billing.money.format import fmt_money


def line(name, cents):
    return f"{name}: {fmt_money(cents)}"
