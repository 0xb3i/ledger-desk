import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { ErrorState } from './components/states';

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed
      ? <main className="p-10"><ErrorState message="页面暂时无法显示。" retry={() => window.location.reload()} /></main>
      : this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(<StrictMode><AppErrorBoundary><App /></AppErrorBoundary></StrictMode>);
