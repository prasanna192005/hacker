Bank API with Observability
This project simulates a banking API (similar to Barclays) with observability using Prometheus (metrics), Loki (logs), Tempo (traces), and Grafana (visualization). It includes multiple routes and intentional errors to generate rich observability data.
Prerequisites

Docker and Docker Compose installed
Node.js 18+ (optional, for local development)
Basic understanding of Grafana and observability

Folder Structure
bank-api/
├── src/
│   └── app.js                # Node.js application
├── config/
│   ├── prometheus.yml       # Prometheus config
│   ├── loki-config.yml      # Loki config
│   └── tempo.yaml           # Tempo config
├── Dockerfile               # Docker file for Node.js app
├── docker-compose.yml       # Docker Compose setup
├── package.json             # Node.js dependencies
└── README.md                # This file

Setup Instructions

Clone the Repository
git clone <repository-url>
cd bank-api


Install Node.js Dependencies (optional, for local testing)
npm install


Start Services with Docker Compose
docker-compose up -d --build

This starts:

Bank API (http://localhost:3000)
Prometheus (http://localhost:9090)
Loki (http://localhost:3100)
Tempo (http://localhost:4317)
Grafana (http://localhost:3001)


Configure Grafana

Open Grafana at http://localhost:3001 (login: admin/admin, change password if prompted).
Add data sources:
Prometheus: URL http://prometheus:9090
Loki: URL http://loki:3100
Tempo: URL http://tempo:4317, select OTLP gRPC protocol


Test connections.


Generate Data

Use these curl commands to test routes and trigger errors:# Register users
curl -X POST http://localhost:3000/register -H "Content-Type: application/json" -d '{"userId":"user1","name":"Alice"}'
curl -X POST http://localhost:3000/register -H "Content-Type: application/json" -d '{"userId":"user2","name":"Bob"}'
# Login
curl -X POST http://localhost:3000/login -H "Content-Type: application/json" -d '{"userId":"user1"}'
# Use token from login response for authenticated routes
curl -X GET http://localhost:3000/balance -H "token: <token>"
curl -X POST http://localhost:3000/transfer -H "token: <token>" -H "Content-Type: application/json" -d '{"toUserId":"user2","amount":500}'
curl -X POST http://localhost:3000/loan -H "token: <token>" -H "Content-Type: application/json" -d '{"amount":5000}'
curl -X GET http://localhost:3000/statement -H "token: <token>"
# Trigger errors
curl -X POST http://localhost:3000/register -H "Content-Type: application/json" -d '{"userId":"user1","name":"Alice"}' # 409 Conflict
curl -X POST http://localhost:3000/transfer -H "token: <token>" -H "Content-Type: application/json" -d '{"toUserId":"user2","amount":5000}' # 400 Insufficient funds
curl -X GET http://localhost:3000/balance -H "token: invalid" # 401 Unauthorized


Hit /metrics to check metrics: curl http://localhost:3000/metrics


Create Grafana Dashboards

Metrics (Prometheus):
Add panels with queries:
rate(http_requests_total[5m]) for request rates by method, route, statusCode
rate(bank_api_errors_total[5m]) for error rates by error_type, endpoint
histogram_quantile(0.95, sum(rate(http_request_duration_ms_bucket[5m])) by (le)) for latency




Logs (Loki):
Add Logs panel, query: {app="bank-api"}
Filter: {app="bank-api"} |= "error" for error logs


Traces (Tempo):
Use Explore, search for service bank-api
View traces for endpoints like POST /transfer





Troubleshooting

No Metrics: Check Prometheus targets (http://localhost:9090/targets), test /metrics endpoint (curl http://localhost:3000/metrics).
No Logs: Verify Loki logs (docker logs loki), ensure Winston-Loki connectivity (check console errors).
No Traces: Check Tempo logs (docker logs tempo), verify OTLP URL (http://tempo:4317).
Loki Schema Issues: If Structured Metadata fails, set allow_structured_metadata: false in loki-config.yml and restart Loki.
Networking: Confirm services on observability network (docker network inspect observability).

Accessing Services

Bank API: http://localhost:3000
Prometheus: http://localhost:9090
Loki: http://localhost:3100
Tempo: http://localhost:4317
Grafana: http://localhost:3001

Verifying Data in Grafana

Metrics: Query bank_api_errors_total to see errors like unauthorized, insufficient_funds.
Logs: Query {app="bank-api"} to see logs like “Transfer completed” or “Insufficient funds”.
Traces: Search bank-api to see traces for /transfer, /loan, etc.

