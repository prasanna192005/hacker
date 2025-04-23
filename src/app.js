const express = require('express');
const winston = require('winston');
const LokiTransport = require('winston-loki');
const promClient = require('prom-client');
const responseTime = require('response-time');
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { registerInstrumentations } = require('@opentelemetry/instrumentation');

// Initialize Express
const app = express();
app.use(express.json());

// Mock Database
const accounts = new Map();
const sessions = new Map();
let requestCount = 0;

// Configure Prometheus Metrics
promClient.collectDefaultMetrics();
const reqResTime = new promClient.Histogram({
  name: 'http_request_duration_ms',
  help: 'Duration of HTTP requests in ms',
  labelNames: ['method', 'route', 'statusCode'],
  buckets: [50, 100, 200, 400, 500, 800, 1000, 2000]
});
const totalRequests = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'statusCode']
});
const errorCounter = new promClient.Counter({
  name: 'bank_api_errors_total',
  help: 'Total number of API errors',
  labelNames: ['error_type', 'endpoint']
});

// Configure Winston for Loki
const logger = winston.createLogger({
  transports: [
    new LokiTransport({
      host: 'http://loki:3100',
      labels: { app: 'bank-api' },
      json: true,
      format: winston.format.json(),
      onConnectionError: (err) => console.error('Loki error:', err)
    })
  ]
});

// Configure OpenTelemetry for Tempo
const provider = new NodeTracerProvider({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: 'bank-api'
  })
});
const exporter = new OTLPTraceExporter({
  url: 'http://tempo:4318'
});
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
provider.register();
registerInstrumentations({
  instrumentations: [
    new HttpInstrumentation(),
    new ExpressInstrumentation()
  ]
});

// Middleware for Metrics and Rate Limiting
app.use(responseTime((req, res, time) => {
  totalRequests.inc({ method: req.method, route: req.url, statusCode: res.statusCode });
  reqResTime.observe({ method: req.method, route: req.url, statusCode: res.statusCode }, time);
}));
app.use((req, res, next) => {
  requestCount++;
  if (requestCount % 10 === 0) {
    errorCounter.inc({ error_type: 'rate_limit', endpoint: req.path });
    logger.error('Rate limit exceeded', { method: req.method, path: req.path });
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
});

// Authentication Middleware
const authenticate = (req, res, next) => {
  const { token } = req.headers;
  if (!token || !sessions.has(token)) {
    errorCounter.inc({ error_type: 'unauthorized', endpoint: req.path });
    logger.error('Unauthorized access', { method: req.method, path: req.path });
    return res.status(401).json({ error: 'Invalid or missing token' });
  }
  req.userId = sessions.get(token);
  next();
};

// Metrics Endpoint
app.get('/metrics', async (req, res) => {
  try {
    logger.info('Metrics endpoint accessed', { timestamp: Date.now() });
    res.set('Content-Type', promClient.register.contentType);
    res.end(await promClient.register.metrics());
  } catch (err) {
    logger.error('Error serving metrics', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Routes
app.post('/register', (req, res) => {
  const { userId, name, balance = 1000 } = req.body;
  if (!userId || !name) {
    errorCounter.inc({ error_type: 'bad_request', endpoint: '/register' });
    logger.error('Invalid registration data', { userId, name });
    return res.status(400).json({ error: 'Missing userId or name' });
  }
  if (accounts.has(userId)) {
    errorCounter.inc({ error_type: 'conflict', endpoint: '/register' });
    logger.error('User already exists', { userId });
    return res.status(409).json({ error: 'User already exists' });
  }
  accounts.set(userId, { name, balance, transactions: [] });
  logger.info('User registered', { userId, name, balance });
  res.status(201).json({ message: 'User registered', userId });
});

app.post('/login', (req, res) => {
  const { userId } = req.body;
  if (!accounts.has(userId)) {
    errorCounter.inc({ error_type: 'not_found', endpoint: '/login' });
    logger.error('User not found', { userId });
    return res.status(404).json({ error: 'User not found' });
  }
  const token = `token_${Math.random().toString(36).slice(2)}`;
  sessions.set(token, userId);
  logger.info('User logged in', { userId, token });
  res.json({ token });
});

app.get('/accounts', authenticate, (req, res) => {
  logger.info('Accounts accessed', { userId: req.userId });
  res.json([...accounts.entries()].map(([id, data]) => ({ id, name: data.name })));
});

app.get('/balance', authenticate, (req, res) => {
  const account = accounts.get(req.userId);
  if (Math.random() < 0.1) { // Simulate random server error
    errorCounter.inc({ error_type: 'server_error', endpoint: '/balance' });
    logger.error('Server error on balance check', { userId: req.userId });
    throw new Error('Database failure');
  }
  logger.info('Balance checked', { userId: req.userId, balance: account.balance });
  res.json({ userId: req.userId, balance: account.balance });
});

app.post('/transfer', authenticate, async (req, res) => {
  const { toUserId, amount } = req.body;
  if (!toUserId || !amount || amount <= 0) {
    errorCounter.inc({ error_type: 'bad_request', endpoint: '/transfer' });
    logger.error('Invalid transfer data', { userId: req.userId, toUserId, amount });
    return res.status(400).json({ error: 'Invalid toUserId or amount' });
  }
  if (!accounts.has(toUserId)) {
    errorCounter.inc({ error_type: 'not_found', endpoint: '/transfer' });
    logger.error('Recipient not found', { userId: req.userId, toUserId });
    return res.status(404).json({ error: 'Recipient not found' });
  }
  const sender = accounts.get(req.userId);
  if (sender.balance < amount) {
    errorCounter.inc({ error_type: 'insufficient_funds', endpoint: '/transfer' });
    logger.error('Insufficient funds', { userId: req.userId, amount, balance: sender.balance });
    return res.status(400).json({ error: 'Insufficient funds' });
  }
  await new Promise(resolve => setTimeout(resolve, 500)); // Simulate processing
  sender.balance -= amount;
  sender.transactions.push({ type: 'debit', amount, to: toUserId, date: new Date() });
  accounts.get(toUserId).balance += amount;
  accounts.get(toUserId).transactions.push({ type: 'credit', amount, from: req.userId, date: new Date() });
  logger.info('Transfer completed', { userId: req.userId, toUserId, amount });
  res.json({ message: 'Transfer successful', amount });
});

app.post('/loan', authenticate, (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0 || amount > 10000) {
    errorCounter.inc({ error_type: 'bad_request', endpoint: '/loan' });
    logger.error('Invalid loan request', { userId: req.userId, amount });
    return res.status(400).json({ error: 'Invalid loan amount (max 10000)' });
  }
  const account = accounts.get(req.userId);
  account.balance += amount;
  account.transactions.push({ type: 'loan', amount, date: new Date() });
  logger.info('Loan approved', { userId: req.userId, amount });
  res.json({ message: 'Loan approved', amount });
});

app.get('/statement', authenticate, (req, res) => {
  const account = accounts.get(req.userId);
  logger.info('Statement accessed', { userId: req.userId });
  res.json({ userId: req.userId, transactions: account.transactions });
});

// Error Handling
app.use((err, req, res, next) => {
  errorCounter.inc({ error_type: 'server_error', endpoint: req.path });
  logger.error('Application error', { error: err.message, stack: err.stack, path: req.path });
  res.status(500).json({ error: 'Internal server error' });
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  console.log(`Server running on port ${PORT}`);
});