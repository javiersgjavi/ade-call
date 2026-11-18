import type { Capabilities } from '../shared/contracts.mjs';
// What a session needs from the conversation: history to resume, recognition
// vocabulary, time and the current conversation identity.
export interface VoiceContext {
  backend?: string; capabilities?: Capabilities; snapshot?: { backend?: string };
  resume(options?: { languages?: string[]; language?: string }): string; rememberClose(): void;
  vocabulary(): string[]; conversation?: () => { id: string }; timing?: () => unknown;
}
