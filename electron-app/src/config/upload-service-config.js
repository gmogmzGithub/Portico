/**
 * Upload service configuration for debug log uploads.
 *
 * The Electron app POSTs to portico-service, which handles S3 storage
 * server-side. No AWS credentials needed in the client.
 *
 * Environment variable override:
 *   portico_UPLOAD_SERVICE_URL — base URL (default: https://portico-service.sandbox.example.invalid)
 *
 * Environments:
 *   Local dev:  http://localhost:8080
 *   Prod:       https://portico-service.sandbox.example.invalid
 */

const UPLOAD_SERVICE_BASE_URL =
  process.env.portico_UPLOAD_SERVICE_URL || 'https://portico-service.sandbox.example.invalid';

module.exports = {
  UPLOAD_SERVICE_BASE_URL,
  UPLOAD_ENDPOINT: `${UPLOAD_SERVICE_BASE_URL}/upload`,
  UPLOAD_MAX_SIZE_BYTES: 50 * 1024 * 1024, // 50 MB
};
