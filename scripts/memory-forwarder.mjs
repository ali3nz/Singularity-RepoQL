// Compatibility TCP forwarder: relays a local port to another host's memory
// core on 8420. Only needed when the memory stack cannot be attached to the
// consumer's Docker network directly — the default setup uses a network alias
// instead (see memory/README.md). Env: MEMORY_TARGET_HOST (required),
// MEMORY_TARGET_PORT (default 8420).
import net from 'node:net';
const targetHost = process.env.MEMORY_TARGET_HOST;
const targetPort = Number(process.env.MEMORY_TARGET_PORT || 8420);
if (!targetHost) throw new Error('MEMORY_TARGET_HOST is required');
const server = net.createServer(client => {
  const upstream = net.connect(targetPort, targetHost);
  client.pipe(upstream).pipe(client);
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on('error', close); upstream.on('error', close);
  client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
});
server.listen(8420, '0.0.0.0', () => console.log('MEMORY_FORWARDER_READY'));
