from .invoice import Bill


def summarize(doc: Bill) -> str:
    return f"{len(doc.lines)} lines, total {doc.total():.2f}"


def merge(a: Bill, b: Bill) -> Bill:
    return Bill(a.lines + b.lines)
