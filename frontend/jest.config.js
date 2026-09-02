/**
 * Jest for the frontend.
 *
 * The package has always declared a `test` script and shipped jest, ts-jest,
 * jsdom and Testing Library, but had no config — so `npm test` at the repo root
 * ran the backend suite, then failed the frontend half with "No tests found"
 * and a non-zero exit. Anything gating a deploy on `npm test` was therefore
 * either ignoring the failure or never running it.
 *
 * Scope: this suite covers the pure logic the app depends on being exactly
 * right — offline pricing, the sync queue, the API client's error
 * classification. Rendering whole pages needs a mocked auth store, a mocked
 * router and a mocked API for every screen, which buys far less confidence per
 * line than `next build` plus the type checker already do.
 *
 * No coverage threshold is set. The backend has one because its surface is
 * almost entirely pure functions; the frontend's is mostly components, and a
 * threshold here would either be met by testing the wrong things or ignored.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // Tailwind is a build step, not something a unit test can import.
    '\\.(css|less|scss|sass)$': '<rootDir>/src/test/style-mock.js',
  },
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
  transform: {
    '^.+\\.(ts|tsx)$': [
      'ts-jest',
      {
        // The app's own tsconfig targets the Next bundler, which ts-jest cannot
        // consume: it needs CommonJS output and classic node resolution. The
        // overrides are the minimum to make the same source run under jest.
        tsconfig: {
          target: 'ES2017',
          lib: ['dom', 'dom.iterable', 'esnext'],
          module: 'commonjs',
          moduleResolution: 'node',
          jsx: 'react-jsx',
          esModuleInterop: true,
          allowJs: true,
          resolveJsonModule: true,
          isolatedModules: false,
          strict: true,
          skipLibCheck: true,
        },
      },
    ],
  },
  collectCoverageFrom: [
    'src/lib/**/*.ts',
    'src/hooks/**/*.ts',
    '!src/**/*.d.ts',
  ],
  coverageDirectory: 'coverage',
  clearMocks: true,
};
