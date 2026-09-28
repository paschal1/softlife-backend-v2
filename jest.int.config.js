/** Integration tests: need a real Postgres (see README). */
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  testRegex: '.*\\.int-spec\\.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
  testTimeout: 30000,
};
