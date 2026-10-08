# tiny-service

A small, dependency-free Node.js library used as a fixture for RAE experiments.

## Modules

- `src/stats.js` provides `mean(values)` and `median(values)` for arrays of numbers.
- `src/format.js` provides `formatDuration(ms)`, which renders a duration in milliseconds as text.

## Checks

Run `npm run check` to execute every `checks/*.check.js` file with the Node.js test runner.
