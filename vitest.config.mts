import { defineConfig } from "vitest/config";

// Only unit tests; eval/tasks contain fixture projects with their own tests.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
