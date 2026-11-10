FROM node:20-alpine AS frontend

WORKDIR /app
COPY web/package.json ./web/package.json
RUN cd web && npm install
COPY web ./web
RUN cd web && npm run build

FROM python:3.12-slim

WORKDIR /app

# 先复制元数据与源码并安装依赖
COPY pyproject.toml ./
COPY src ./src
COPY --from=frontend /app/src/model_relay/static ./src/model_relay/static
RUN pip install --no-cache-dir -e .

# 使用示例配置作为默认配置，运行时可挂载覆盖
COPY config.example.yaml ./config.yaml

EXPOSE 8080

CMD ["uvicorn", "model_relay.main:app", "--host", "0.0.0.0", "--port", "8080"]
