/** Representative provider envelopes for the TypeScript and Python SDK session projections. */
export function appendBedrockExchanges(session) {
  const request = JSON.stringify({
    modelId: 'bedrock-snapshot-model',
    messages: [{ role: 'user', content: [{ text: 'Continue after: part one' }] }],
    inferenceConfig: { maxTokens: 768 },
  })
  const shared = { attempt: 2, continuation: 1, request, characters: Array.from(request).length, limit: 3750 }
  session.append('llm/bedrock-exchange', { phase: 'request', ...shared })
  session.append('llm/bedrock-exchange', {
    phase: 'response', ...shared, status: 200,
    response: {
      role: 'assistant', api: 'bedrock-converse-stream', provider: 'amazon-bedrock', model: 'bedrock-snapshot-model', timestamp: 0,
      content: [{ type: 'text', text: ' and two' }], stopReason: 'stop',
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
  })
}
