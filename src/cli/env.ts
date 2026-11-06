// Loads .env.local and .env into process.env, for the CLI. Shell variables win. Imported first by
// main.ts, before anything reads process.env (auth.ts reads it at import time).
import { existsSync } from "node:fs"

for (const file of [".env.local", ".env"]) if (existsSync(file)) process.loadEnvFile(file)
