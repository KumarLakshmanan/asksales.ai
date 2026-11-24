import React, { Component, ReactNode } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  isReconnecting: boolean;
  reconnectAttempts: number;
}

/**
 * Error Boundary specifically for WebSocket-related errors
 * Provides automatic recovery and manual retry options
 */
export class WebSocketErrorBoundary extends Component<Props, State> {
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private maxReconnectAttempts = 3;

  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      isReconnecting: false,
      reconnectAttempts: 0,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    // Update state so the next render will show the fallback UI
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[WebSocketErrorBoundary] Caught error:', error);
    console.error('[WebSocketErrorBoundary] Error info:', errorInfo);

    this.setState({
      error,
      errorInfo,
    });

    // Check if it's a WebSocket-related error using multiple indicators
    const isWebSocketError = this.isWebSocketRelatedError(error, errorInfo);

    if (isWebSocketError) {
      // Attempt automatic reconnection
      this.attemptAutoReconnect();
    }
  }

  /**
   * Determine if the error is WebSocket-related
   */
  private isWebSocketRelatedError(error: Error, errorInfo: React.ErrorInfo): boolean {
    // Check error message
    const errorMessage = error.message?.toLowerCase() || '';
    const hasWebSocketKeywords = 
      errorMessage.includes('websocket') ||
      errorMessage.includes('ws://') ||
      errorMessage.includes('wss://') ||
      errorMessage.includes('connection') ||
      errorMessage.includes('disconnect') ||
      errorMessage.includes('network');

    // Check error name
    const errorName = error.name?.toLowerCase() || '';
    const hasWebSocketErrorName = 
      errorName.includes('websocket') ||
      errorName === 'networkerror';

    // Check component stack for WebSocket-related components
    const componentStack = errorInfo.componentStack?.toLowerCase() || '';
    const hasWebSocketComponent = 
      componentStack.includes('websocket') ||
      componentStack.includes('chat') ||
      componentStack.includes('agent');

    return hasWebSocketKeywords || hasWebSocketErrorName || hasWebSocketComponent;
  }

  componentWillUnmount() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
  }

  attemptAutoReconnect = () => {
    const { reconnectAttempts } = this.state;

    if (reconnectAttempts >= this.maxReconnectAttempts) {
      return;
    }

    this.setState({
      isReconnecting: true,
      reconnectAttempts: reconnectAttempts + 1,
    });

    // Wait 3 seconds before attempting reconnect
    const delay = 3000 * Math.pow(2, reconnectAttempts);
    this.reconnectTimer = setTimeout(() => {
      this.handleReset();
    }, delay);
  };

  handleReset = () => {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    // Reset error state
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      isReconnecting: false,
      reconnectAttempts: 0,
    });

    // Call custom reset handler if provided
    this.props.onReset?.();
  };

  handleManualRetry = () => {
    this.setState({ reconnectAttempts: 0 });
    this.handleReset();
  };

  render() {
    const { hasError, error, isReconnecting, reconnectAttempts } = this.state;
    const { children } = this.props;

    if (hasError && error) {
      return (
        <div className="flex items-center justify-center h-full p-8">
          <Alert variant="destructive" className="max-w-2xl">
            <AlertCircle className="h-5 w-5" />
            <AlertTitle className="text-lg font-semibold mb-2">
              Connection Error
            </AlertTitle>
            <AlertDescription className="space-y-4">
              <div>
                <p className="text-sm mb-2">
                  We&apos;re having trouble maintaining a connection to the server.
                </p>
                <p className="text-xs text-muted-foreground mb-4">
                  {error.message}
                </p>

                {isReconnecting && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    <span>
                      Trying to reconnect... (Attempt {reconnectAttempts}/{this.maxReconnectAttempts})
                    </span>
                  </div>
                )}

                {reconnectAttempts >= this.maxReconnectAttempts && (
                  <p className="text-sm text-amber-600 mb-4">
                    Automatic reconnection failed. Please try manually.
                  </p>
                )}
              </div>

              <div className="flex gap-2">
                <Button
                  onClick={this.handleManualRetry}
                  variant="default"
                  size="sm"
                  disabled={isReconnecting}
                >
                  <RefreshCw className={`h-4 w-4 mr-2 ${isReconnecting ? 'animate-spin' : ''}`} />
                  Retry Connection
                </Button>

                <Button
                  onClick={() => window.location.reload()}
                  variant="outline"
                  size="sm"
                >
                  Reload Page
                </Button>
              </div>

              <details className="text-xs mt-4">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Technical Details
                </summary>
                <pre className="mt-2 p-2 bg-muted rounded text-xs overflow-auto max-h-40">
                  {error.stack}
                </pre>
              </details>
            </AlertDescription>
          </Alert>
        </div>
      );
    }

    return children;
  }
}

export default WebSocketErrorBoundary;
