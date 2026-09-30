"""Fixture for module-scope CALLS extraction."""


def helper(value: int) -> int:
    return value * 2


def main() -> None:
    helper(21)


if __name__ == "__main__":
    main()
