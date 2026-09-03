import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';

export interface OAuthPendingFlow {
  redirectUri: string;
  createdAt: number;
}

const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_FLOWS = 1000;

/**
 * Bounded in-memory store for OAuth mobile flows keyed by the `state` parameter
 * Prologue sends to /auth/openid. Entries expire after STATE_TTL_MS and the store
 * refuses to grow beyond MAX_FLOWS, so a client cannot exhaust memory.
 */
@Injectable()
export class AudiobookshelfOAuthStateStore {
  private readonly flows = new Map<string, OAuthPendingFlow>();

  create(redirectUri: string): string {
    this.evictExpired();
    if (this.flows.size >= MAX_FLOWS) {
      // Drop the oldest entry to stay bounded.
      const oldest = this.flows.keys().next().value;
      if (oldest !== undefined) this.flows.delete(oldest);
    }
    const state = randomBytes(32).toString('hex');
    this.flows.set(state, { redirectUri, createdAt: Date.now() });
    return state;
  }

  /** Registers a client-supplied state (Prologue sends its own state). */
  register(state: string, redirectUri: string): void {
    this.evictExpired();
    this.flows.set(state, { redirectUri, createdAt: Date.now() });
  }

  /** Reads a flow without consuming it (login page checks state validity). */
  peek(state: string): OAuthPendingFlow | null {
    const flow = this.flows.get(state);
    if (!flow) return null;
    if (Date.now() - flow.createdAt > STATE_TTL_MS) {
      this.flows.delete(state);
      return null;
    }
    return flow;
  }

  /** Consumes and returns the flow for a state, or null when unknown/expired. */
  consume(state: string): OAuthPendingFlow | null {
    const flow = this.peek(state);
    if (flow) this.flows.delete(state);
    return flow;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [state, flow] of this.flows) {
      if (now - flow.createdAt > STATE_TTL_MS) this.flows.delete(state);
    }
  }
}
