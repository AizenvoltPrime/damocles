class GapRegistry:
    @staticmethod
    def lookup(key):
        return key


def run_all():
    value = GapRegistry.lookup("k")
    helper_fn(value)
    return value


def helper_fn(v):
    return v
