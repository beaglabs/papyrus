import type { ClientMsg } from '@papyrus/core/sync/protocol'

const DATABASE = 'papyrus-client'
const STORE = 'operation-outbox'

export interface QueuedOperation {
  key: string
  projectId: string
  operationId: string
  message: ClientMsg
  queuedAt: number
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, { keyPath: 'key' })
        store.createIndex('projectId', 'projectId', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function queueOperation(projectId: string, message: ClientMsg): Promise<void> {
  const operationId = 'operationId' in message ? message.operationId : undefined
  if (!operationId) throw new Error('Durable mutations require an operation ID')
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).put({
      key: `${projectId}:${operationId}`,
      projectId,
      operationId,
      message,
      queuedAt: Date.now(),
    } satisfies QueuedOperation)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  database.close()
}

export async function listQueuedOperations(projectId: string): Promise<QueuedOperation[]> {
  const database = await openDatabase()
  const result = await new Promise<QueuedOperation[]>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readonly')
    const request = transaction.objectStore(STORE).index('projectId').getAll(projectId)
    request.onsuccess = () => resolve(request.result as QueuedOperation[])
    request.onerror = () => reject(request.error)
  })
  database.close()
  return result.sort((a, b) => a.queuedAt - b.queuedAt)
}

export async function acknowledgeOperation(projectId: string, operationId: string): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).delete(`${projectId}:${operationId}`)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  database.close()
}
