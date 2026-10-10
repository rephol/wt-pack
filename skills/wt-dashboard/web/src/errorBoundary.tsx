// WP-305: a render error anywhere used to unmount the whole app (a blank page, nothing in the UI). Show it and offer a reload.
import { Component, type ReactNode } from 'react'

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error) { console.error('render error:', error) }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div role="alert" style={{ padding: 24, font: '14px system-ui', color: 'inherit' }}>
        <h3 style={{ margin: '0 0 8px' }}>Something broke while drawing this page</h3>
        <pre style={{ whiteSpace: 'pre-wrap', opacity: 0.8 }}>{this.state.error.message}</pre>
        <button onClick={() => location.reload()}>Reload</button>
      </div>
    )
  }
}
