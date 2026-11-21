class Stock:
    def __init__(self) -> None:
        self._counts: dict[str, int] = {}

    def count(self, sku: str) -> int:
        return self._counts.get(sku, 0)
