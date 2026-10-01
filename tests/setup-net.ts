// The tests simulate the connection with one-shot failures (`failNext`, `offline`), so by default
// Drive requests are NOT retried and nothing waits. Tests of the retry behaviour turn it on.
// `NET_RETRY_ON=1 npx vitest run` runs every test with retries on (1 ms waits) as a regression check.
import { net } from '../helpers/net-retry';

// eslint-disable-next-line no-undef -- vitest runs in node, where process exists
net.delays = process.env.NET_RETRY_ON ? [1, 1, 1] : [];
net.settleMs = 0;
