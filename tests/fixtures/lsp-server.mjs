import { pathToFileURL } from 'node:url';
let buffer = Buffer.alloc(0);
let document;
const send = (message) => {
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
  process.stdout.write(`Content-Length: ${bytes.length}\r\n\r\n`);
  process.stdout.write(bytes);
};
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
    buffer = buffer.subarray(end + 4 + length);
    if (message.method === 'initialize')
      send({
        id: message.id,
        result: { capabilities: { textDocumentSync: 1, definitionProvider: true } },
      });
    else if (message.method === 'textDocument/didOpen') document = message.params.textDocument;
    else if (message.method === 'textDocument/didChange')
      document = { ...message.params.textDocument, text: message.params.contentChanges[0].text };
    else if (message.method === 'textDocument/definition')
      send({
        id: message.id,
        result: [
          {
            uri: document.uri,
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
          },
          { uri: pathToFileURL('/outside/private.ts').href, range: {} },
        ],
      });
    else if (message.method === 'textDocument/hover')
      send({ id: message.id, result: { contents: { kind: 'plaintext', value: document.text } } });
    else if (
      message.method === 'textDocument/diagnostic' &&
      document.text.includes('transport-error')
    )
      send({ id: message.id, error: { code: -32603, message: 'Fixture transport failed' } });
    else if (message.method === 'textDocument/diagnostic')
      send({
        id: message.id,
        result: {
          kind: 'full',
          items: [
            {
              message: document.text.includes('error') ? 'Fixture type error' : 'No fixture error',
              severity: 1,
            },
          ],
        },
      });
    else if (message.id) send({ id: message.id, result: [] });
  }
});
