const WebSocket = require('ws');

async function runTest() {
  console.log('Connecting to ws://localhost:3737/ws...');
  const ws = new WebSocket('ws://localhost:3737/ws');

  ws.on('open', () => {
    console.log('✓ WebSocket connected successfully!');
    ws.close();
    process.exit(0);
  });

  ws.on('error', (err) => {
    console.error('✗ WebSocket connection failed:', err);
    process.exit(1);
  });

  setTimeout(() => {
    console.error('✗ Timeout waiting for WebSocket');
    process.exit(1);
  }, 3000);
}

runTest();
