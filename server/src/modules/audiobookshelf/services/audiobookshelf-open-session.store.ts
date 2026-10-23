import { Injectable } from '@nestjs/common';

export interface AudiobookshelfOpenSession {
  userId: number;
  bookId: number;
  isSuperuser: boolean;
  /** The device that opened the session; sync/close bodies do not carry deviceInfo. */
  deviceKey?: string | null;
}

/**
 * Tracks live playback sessions opened through the ABS play endpoint so the public
 * `/public/session/:id/track/:index` stream route (used by AudioBooth and similar clients) can
 * resolve a session id to a user+book without authentication. Mirrors upstream ABS, where the
 * track route only serves *open* sessions and 404s unknown or closed ones - the session id is the
 * bearer secret there, and the in-memory registry keeps BookOrbit's deterministic composite ids
 * from opening any book to anyone who can guess a (userId, bookId) pair.
 *
 * In-memory by design: a server restart closes all sessions, which is the same behavior as
 * upstream's in-memory session manager. Entries expire after the upstream stale-session cutoff
 * (36h) and are refreshed on sync.
 */
@Injectable()
export class AudiobookshelfOpenSessionStore {
  private readonly sessions = new Map<string, AudiobookshelfOpenSession & { expiresAt: number }>();

  private static readonly TTL_MS = 36 * 60 * 60 * 1000;

  open(sessionId: string, session: AudiobookshelfOpenSession): void {
    this.sessions.set(sessionId, { ...session, expiresAt: Date.now() + AudiobookshelfOpenSessionStore.TTL_MS });
  }

  /** Refreshes the expiry of an open session on sync/close activity. */
  touch(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.expiresAt = Date.now() + AudiobookshelfOpenSessionStore.TTL_MS;
  }

  get(sessionId: string): AudiobookshelfOpenSession | null {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.sessions.delete(sessionId);
      return null;
    }
    return { userId: entry.userId, bookId: entry.bookId, isSuperuser: entry.isSuperuser, deviceKey: entry.deviceKey };
  }

  close(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
