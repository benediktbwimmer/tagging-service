process.env.NODE_ENV = 'test';
process.env.CATALOG_TOKEN = process.env.CATALOG_TOKEN || 'test-token';
process.env.CATALOG_BASE_URL = process.env.CATALOG_BASE_URL || 'http://127.0.0.1:4000';
process.env.FILE_EXPLORER_BASE_URL = process.env.FILE_EXPLORER_BASE_URL || 'http://127.0.0.1:4174';
process.env.AI_CONNECTOR_BASE_URL = process.env.AI_CONNECTOR_BASE_URL || 'http://127.0.0.1:8000';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.DATABASE_PATH = process.env.DATABASE_PATH || './tmp/test-db.sqlite';
process.env.WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || './tmp/workspace';
