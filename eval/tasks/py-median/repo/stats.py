def mean(xs):
    if not xs:
        raise ValueError("empty")
    return sum(xs) / len(xs)


def median(xs):
    raise NotImplementedError
