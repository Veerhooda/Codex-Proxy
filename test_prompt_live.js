const WebSocket = require('ws');

async function testPromptStreaming() {
  console.log('Connecting to ws://localhost:3737/ws for live prompt test...');
  const ws = new WebSocket('ws://localhost:3737/ws');

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  console.log('✓ Connected. Sending test prompt: "Reply with exactly: LIVETEST_SUCCESS"...');

  const receivedEvents = [];

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    receivedEvents.push(msg);

    if (msg.type === 'codex_event') {
      const e = msg.event;
      if (e.type === 'item.completed' && (e.item?.type === 'agent_message' || e.item?.type === 'AgentMessage')) {
        console.log('✓ [RECEIVED ASSISTANT MESSAGE]:', e.item.text || e.item.content?.[0]?.text);
      } else if (e.type === 'turn.completed') {
        console.log('✓ [TURN COMPLETED], tokens:', e.usage?.output_tokens);
      }
    } else if (msg.type === 'complete') {
      console.log('✓ [STREAM COMPLETED FULLY]');
      ws.close();
      process.exit(0);
    }
  });

  ws.send(JSON.stringify({
    type: 'prompt',
    prompt: 'Reply with exactly: LIVETEST_SUCCESS',
    model: 'muse-spark-1.3-contributor',
    provider: 'meta',
    bypassSandbox: true
  }));

  setTimeout(() => {
    console.error('✗ Timeout waiting for prompt execution');
    ws.close();
    process.exit(1);
  }, 35000);
}

testPromptStreaming().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
