from inventory.stock import Stock


def test_unknown_sku_is_zero():
    assert Stock().count("nope") == 0
