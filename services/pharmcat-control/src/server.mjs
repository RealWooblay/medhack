import { createServer } from 'node:http'

import { createControlHandler } from './control.mjs'

const port = Number(process.env.PORT ?? '8080')
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT is invalid.')
}

const handle = createControlHandler()

createServer(async (incoming, outgoing) => {
  try {
    const chunks = []
    let total = 0
    for await (const chunk of incoming) {
      total += chunk.length
      if (total > 32 * 1024) {
        outgoing.writeHead(413, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' })
        outgoing.end(JSON.stringify({ error: { code: 'request_too_large', message: 'The request is too large.' } }))
        return
      }
      chunks.push(chunk)
    }
    const headers = new Headers()
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) value.forEach((item) => headers.append(name, item))
      else if (value !== undefined) headers.set(name, value)
    }
    const body = Buffer.concat(chunks)
    const request = new Request(`http://control.internal${incoming.url ?? '/'}`, {
      method: incoming.method,
      headers,
      ...(body.length ? { body } : {}),
    })
    const response = await handle(request)
    const responseHeaders = Object.fromEntries(response.headers.entries())
    outgoing.writeHead(response.status, responseHeaders)
    outgoing.end(Buffer.from(await response.arrayBuffer()))
  } catch {
    outgoing.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' })
    outgoing.end(JSON.stringify({ error: { code: 'control_failed', message: 'The genome-analysis service failed safely.' } }))
  }
}).listen(port)
