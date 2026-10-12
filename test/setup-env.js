// Test-only secrets. Loaded before any module that reads process.env.
process.env.JWT_SECRET = 'test-jwt-secret-'.padEnd(64, 'x');
process.env.ADMIN_PASSWORD = 'correct-horse-battery-staple';
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.CORS_ORIGIN = 'https://app.example.com';
