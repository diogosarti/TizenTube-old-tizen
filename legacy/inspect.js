'use strict';
// Evaluate an expression in an already enabled Web Inspector; keep replies in RAM.
const WebSocket = require('ws');
const [endpoint] = process.argv.slice(2);
if (!endpoint) throw new Error('Usage: node inspect.js ws://HOST:PORT/devtools/page/ID < expression.js');
let expression = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { expression += chunk; });
process.stdin.on('end', () => {
    const socket = new WebSocket(endpoint);
    const timer = setTimeout(() => { console.error('Inspector request timed out'); socket.terminate(); process.exitCode = 1; }, 10000);
    socket.on('open', () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })));
    socket.on('message', bytes => {
        const reply = JSON.parse(bytes.toString());
        if (reply.id !== 1) return;
        clearTimeout(timer);
        console.log(JSON.stringify(reply.result || reply.error, null, 2));
        if (reply.error || reply.result && reply.result.wasThrown) process.exitCode = 1;
        socket.terminate();
    });
    socket.on('error', error => { clearTimeout(timer); console.error(error.code || 'Inspector connection failed'); process.exitCode = 1; });
});
