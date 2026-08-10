import path from 'node:path';

export function loadProjectEnv(file = path.resolve('.env')): void {
  try {
    process.loadEnvFile(file);
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}
