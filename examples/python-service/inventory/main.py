from fastapi import FastAPI

from inventory.stock import Stock

app = FastAPI()
stock = Stock()


@app.get("/items/{sku}")
def item(sku: str) -> dict:
    return {"sku": sku, "count": stock.count(sku)}
