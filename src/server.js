const { assertConfig } = require('./config');
assertConfig();

const queue = require('./queue/jobQueue');
const { createApp } = require('./app');

const app = createApp(queue);
// Behind a reverse proxy, set TRUST_PROXY=1 so rate limiting sees real client IPs.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`\n  🎯 Subscription Sniper running on port ${port}\n`));
