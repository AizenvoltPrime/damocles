export interface ElicitationRequest {
  serverName: string;
  message: string;
  mode: 'form' | 'url';
  url?: string;
  elicitationId: string;
  requestedSchema?: Record<string, unknown>;
}

export interface ElicitationResult {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}
