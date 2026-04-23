# Integration Usage

Run the standard current-contract operator integration harness:

```bash
cd integration
npm install
npm run test:operator
```

Run the slightly deeper pass:

```bash
npm run test:e2e
```

Run the regression bundle:

```bash
npm run test:regression
```

Run deterministic protocol conformance vectors:

```bash
npm run test:conformance
```

Force preferred local ports:

```bash
SERVER_PORT=8780 RELAY_PORT=8781 DAEMON_PORT=8790 npm run test:operator
```

Use a specific PHP binary:

```bash
PHP_BIN="$(command -v php84)" npm run test:operator
```

Point at a different platform checkout:

```bash
PLATFORM_ROOT=/path/to/platform npm run test:operator
```
