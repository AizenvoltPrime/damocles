"""Fixture for Python argument_list REFERENCES extraction."""


def handler(payload: dict) -> None:
    return None


def schedule(executor) -> None:
    executor.submit(handler)
