import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

interface Connection {
  client: Client
  transport: StreamableHTTPClientTransport
}

export async function validateMcpServer(endpoint: string, accessToken?: string): Promise<void> {
  await withMcpClient(endpoint, accessToken, async (client) => {
    await client.listTools()
  })
}

export async function listMcpTools(endpoint: string, accessToken?: string): Promise<McpToolDefinition[]> {
  return await withMcpClient(endpoint, accessToken, async (client) => {
    const { tools } = await client.listTools()
    return tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
    }))
  })
}

export async function callMcpTool(endpoint: string, accessToken: string | undefined, name: string, args: unknown): Promise<unknown> {
  return await withMcpClient(endpoint, accessToken, async (client) => {
    return await client.callTool({
      name,
      arguments: isRecord(args) ? args : {},
    })
  })
}

async function withMcpClient<T>(endpoint: string, accessToken: string | undefined, operation: (client: Client) => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(30_000)
  const options = {
    requestInit: { signal },
    ...(accessToken ? { authProvider: { token: async () => accessToken } } : {}),
  }
  const connection = connect(endpoint, options)
  try {
    const { client } = await connection
    return await operation(client)
  } finally {
    await close(await connection.catch(() => undefined))
  }
}

async function connect(endpoint: string, options: ConstructorParameters<typeof StreamableHTTPClientTransport>[1]): Promise<Connection> {
  const client = new Client({ name: 'Papyrus', version: '0.1.0' })
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), options)
  await client.connect(transport)
  return { client, transport }
}

async function close(connection: Connection | undefined): Promise<void> {
  if (!connection) return
  try { await connection.transport.terminateSession() } catch { /* Server may be stateless. */ }
  try { await connection.client.close() } catch { /* The primary operation result is more useful. */ }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
