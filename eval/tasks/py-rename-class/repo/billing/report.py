from .invoice import Invoice


def summarize(doc: Invoice) -> str:
    return f"{len(doc.lines)} lines, total {doc.total():.2f}"


def merge(a: Invoice, b: Invoice) -> Invoice:
    return Invoice(a.lines + b.lines)
