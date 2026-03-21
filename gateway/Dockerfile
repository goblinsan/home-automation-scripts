FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt /tmp/requirements.txt
COPY gateway/requirements.txt /tmp/gateway-requirements.txt

RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r /tmp/requirements.txt -r /tmp/gateway-requirements.txt

COPY gateway /app/gateway
COPY tools /app/tools

RUN useradd --create-home --shell /usr/sbin/nologin gateway

USER gateway

EXPOSE 8081 8082

CMD ["sh", "-c", "exec gunicorn --workers 1 --bind 0.0.0.0:${GATEWAY_PORT:-8081} --access-logfile - --error-logfile - --capture-output gateway.app:app"]
