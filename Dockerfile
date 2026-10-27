# 纹以载道 · RAG 后端  —  Dockerfile（Render / Railway 通用）
# 基础镜像锁定 3.11，依赖版本见 requirements.txt（已端到端验证）
FROM python:3.11-slim

WORKDIR /app

# 先装依赖（利用镜像层缓存，改代码不会重装）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 再拷全部代码 + 预建好的向量库 chroma_db
COPY . .

# 暴露端口（平台会注入 PORT 环境变量）
EXPOSE 8000

# 启动：uvicorn 监听 0.0.0.0，端口取环境变量 PORT（平台给多少用多少）
CMD ["sh", "-c", "python -m uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
