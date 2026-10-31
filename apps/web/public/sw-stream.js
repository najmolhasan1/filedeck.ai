// Service Worker for Progressive On-Demand Video & Media Streaming from Telegram Cloud
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname === '/stream-media') {
    event.respondWith(handleMediaStreaming(event));
  }
});

async function handleMediaStreaming(event) {
  const url = new URL(event.request.url);
  const msgId = parseInt(url.searchParams.get('msgId') || '0', 10);
  const totalSize = parseInt(url.searchParams.get('size') || '0', 10);
  const mime = url.searchParams.get('mime') || 'video/mp4';

  if (!msgId || !totalSize) {
    return new Response('Missing stream parameters', { status: 400 });
  }

  const rangeHeader = event.request.headers.get('range');
  let start = 0;
  let end = totalSize - 1;

  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    start = parseInt(parts[0], 10) || 0;
    if (parts[1]) {
      end = parseInt(parts[1], 10);
    }
  }

  // Request chunks in 512 KB blocks for smooth frame-by-frame buffering
  const CHUNK_SIZE = 512 * 1024;
  const lengthToFetch = Math.min(CHUNK_SIZE, totalSize - start, (end - start + 1));
  const chunkEnd = start + lengthToFetch - 1;

  // Request chunk from the active window client
  let client = await self.clients.get(event.clientId);
  if (!client) {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (allClients && allClients.length > 0) {
      client = allClients[0];
    }
  }

  if (!client) {
    return new Response('No client available to fetch stream', { status: 503 });
  }

  try {
    const buffer = await new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => {
        reject(new Error('Stream chunk timeout'));
      }, 15000);

      channel.port1.onmessage = (e) => {
        clearTimeout(timeout);
        if (e.data.error) {
          reject(new Error(e.data.error));
        } else {
          resolve(e.data.buffer);
        }
      };

      client.postMessage({
        type: 'FETCH_STREAM_CHUNK',
        msgId,
        offset: start,
        length: lengthToFetch,
      }, [channel.port2]);
    });

    return new Response(buffer, {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'Content-Range': `bytes ${start}-${chunkEnd}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(lengthToFetch),
        'Content-Type': mime,
      },
    });
  } catch (err) {
    return new Response('Stream chunk error: ' + (err.message || String(err)), { status: 500 });
  }
}
