// ssh's ProxyCommand in the e2e ssh config: copies ssh's stdin and stdout to the spec's flaky proxy on 127.0.0.1:<port>,
// and exits as soon as that connection ends, so a cut proxy connection ends ssh at once.
const { connect } = require('node:net');

const socket = connect(Number(process.argv[2]), '127.0.0.1');
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on('close', () => process.exit(0));
socket.on('error', (error) => {
  process.stderr.write(`flaky proxy connection: ${error.message}\n`);
  process.exit(1);
});
