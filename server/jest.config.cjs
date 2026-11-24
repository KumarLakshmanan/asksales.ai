module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/tests/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
        {
        useESM: true,
        diagnostics: false,
        tsconfig: 'tsconfig.test.json',
      },
    ],
  },
  collectCoverageFrom: [
    'controllers/**/*.ts',
    'services/**/*.ts',
    '!**/*.d.ts',
    '!**/node_modules/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // drizzle-zod's ESM build does `import { Column } from 'drizzle-orm'` which
    // Jest's vm-modules ESM can't resolve (doesn't follow export* barrel re-exports).
    // Return a no-op stub — schema shapes are never evaluated in unit tests.
    '^drizzle-zod$': '<rootDir>/tests/__mocks__/drizzle-zod.cjs',
    '^drizzle-zod/(.*)$': '<rootDir>/tests/__mocks__/drizzle-zod.cjs',
  },
  // Prefer CJS export conditions for packages whose ESM barrel exports
  // break Jest's experimental vm-modules static-name enumeration.
  // With 'require' in the list, drizzle-orm resolves to index.cjs and
  // Jest wraps it as a SyntheticModule exposing all named exports.
  testEnvironmentOptions: {
    customExportConditions: ['require', 'default', 'node'],
  },
};
