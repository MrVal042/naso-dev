FROM python:3.12-slim
WORKDIR /app
COPY . .
RUN pip install .
CMD ["uvicorn", "inventory.main:app", "--host", "0.0.0.0"]
