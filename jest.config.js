const nextJest = require("next/jest")

const createJestConfig = nextJest({ dir: "./" })

// The board's own logic is small and server-side (route guards, the ws/lib
// bridge), so tests run in Node. The ws CLI has its own node:test suite in ws/.
module.exports = createJestConfig({
  testEnvironment: "node",
  moduleNameMapper: { "^@/(.*)$": "<rootDir>/$1" },
  testMatch: ["<rootDir>/__tests__/**/*.test.ts"],
  testPathIgnorePatterns: ["/node_modules/", "/.next/", "/.next-prod/", "<rootDir>/ws/"],
})
