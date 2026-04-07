export type ConnectionState = 'idle' | 'connected' | 'extension-replaced'
export type TabState = 'connecting' | 'connected' | 'error'

export interface TabInfo {
  sessionId?: string
  targetId?: string
  state: TabState
  errorText?: string
  pinnedCount?: number
  attachOrder?: number
}

export interface ExtensionState {
  tabs: Map<number, TabInfo>
  connectionState: ConnectionState
  currentTabId: number | undefined
  errorText: string | undefined
}
