import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { Public } from '../../../common/decorators/public.decorator';
import { AuthService } from '../../../modules/auth/auth.service';
import { AbsOAuthStateStore } from '../services/abs-oauth-state.store';
import { ABS_BASE_PATH } from '../audiobookshelf.constants';
import { AudiobookshelfEnabledGuard } from '../audiobookshelf-enabled.guard';

const BLOCKED_SCHEMES = new Set(['http', 'https', 'javascript', 'data', 'file', 'vbscript']);
const STATE_PATTERN = /^[a-zA-Z0-9_-]{8,512}$/;

/**
 * Audiobookshelf-compatible OAuth2 mobile flow used by Prologue's "Sign In".
 *
 * Mirrors the ABS protocol: Prologue opens /auth/openid with a custom-scheme
 * redirect_uri plus PKCE params, the server sends the user through a login page,
 * and finally redirects the browser to /auth/openid/mobile-redirect?code=...&state=...
 * which forwards code + state to the app's custom scheme.
 *
 * BookOrbit acts as its own identity provider here: the login page authenticates
 * against regular BookOrbit accounts and the "code" is a BookOrbit access token.
 */
@Controller('auth/openid')
@Public()
@UseGuards(AudiobookshelfEnabledGuard)
export class AbsOAuthController {
  constructor(
    private readonly stateStore: AbsOAuthStateStore,
    private readonly authService: AuthService,
  ) {}

  /** GET /auth/openid - starts the flow; redirects to the BookOrbit login page. */
  @Get()
  start(
    @Query('redirect_uri') redirectUri: string | undefined,
    @Query('state') state: string | undefined,
    @Query('code_challenge') codeChallenge: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    if (redirectUri === undefined || !isCustomSchemeUrl(redirectUri)) {
      return reply.status(400).send('Invalid redirect_uri');
    }
    if (codeChallenge === undefined) {
      return reply.status(400).send('code_challenge required for mobile flow (PKCE)');
    }

    const effectiveState = state !== undefined && STATE_PATTERN.test(state) ? state : this.stateStore.create(redirectUri);
    if (state === undefined || !STATE_PATTERN.test(state)) {
      return reply.code(302).redirect(`${ABS_BASE_PATH}/auth/openid/login?state=${encodeURIComponent(effectiveState)}`);
    }
    // Prologue supplied its own state: register it so mobile-redirect can validate it.
    this.stateStore.register(effectiveState, redirectUri);
    return reply.code(302).redirect(`${ABS_BASE_PATH}/auth/openid/login?state=${encodeURIComponent(effectiveState)}`);
  }

  /** GET /auth/openid/login - the login form shown inside Prologue's webview. */
  @Get('login')
  loginPage(@Query('state') state: string | undefined, @Query('error') error: string | undefined, @Res() reply: FastifyReply) {
    reply.type('text/html').header('Cache-Control', 'no-store');
    return reply.send(renderLoginPage(state ?? '', error ?? ''));
  }

  /** POST /auth/openid/login - validates credentials and continues the flow. */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: { username?: string; password?: string; state?: string }, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const state = typeof body.state === 'string' ? body.state : '';
    const flow = this.stateStore.peek(state);
    if (!flow) {
      reply.type('text/html').header('Cache-Control', 'no-store');
      return reply.send(renderLoginPage(state, 'This sign-in link has expired. Please try again from the app.'));
    }
    if (typeof body.username !== 'string' || typeof body.password !== 'string' || !body.username || !body.password) {
      reply.type('text/html').header('Cache-Control', 'no-store');
      return reply.send(renderLoginPage(state, 'Enter your username and password.'));
    }

    try {
      const { accessToken } = await this.authService.loginForAudiobookshelf({ username: body.username, password: body.password }, reply, req.ip);
      return reply
        .code(302)
        .redirect(`${ABS_BASE_PATH}/auth/openid/mobile-redirect?code=${encodeURIComponent(accessToken)}&state=${encodeURIComponent(state)}`);
    } catch {
      reply.type('text/html').header('Cache-Control', 'no-store');
      return reply.send(renderLoginPage(state, 'Invalid username or password.'));
    }
  }

  /** GET /auth/openid/mobile-redirect - forwards code + state to the app scheme. */
  @Get('mobile-redirect')
  mobileRedirect(@Query('code') code: string | undefined, @Query('state') state: string | undefined, @Res() reply: FastifyReply) {
    if (typeof state !== 'string' || typeof code !== 'string' || !code || !state) {
      return reply.status(400).send('Missing code or state');
    }
    const flow = this.stateStore.consume(state);
    if (!flow) {
      return reply.status(400).send('State parameter mismatch');
    }
    return reply.code(302).redirect(`${flow.redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
  }
}

/** Accepts custom-scheme URLs only (e.g. prologue://oauth), never http(s) or dangerous schemes. */
function isCustomSchemeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const scheme = url.protocol.replace(/:$/, '').toLowerCase();
    return !BLOCKED_SCHEMES.has(scheme) && /^[a-z][a-z0-9+.-]*$/.test(scheme);
  } catch {
    return false;
  }
}

function renderLoginPage(state: string, error: string): string {
  const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BookOrbit sign in</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1c1c1e; color: #f2f2f7; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  form { background: #2c2c2e; padding: 28px; border-radius: 14px; width: min(320px, 86vw); display: flex; flex-direction: column; gap: 12px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  input { padding: 11px 12px; border-radius: 9px; border: 1px solid #48484a; background: #1c1c1e; color: #f2f2f7; font-size: 15px; }
  button { padding: 12px; border-radius: 9px; border: 0; background: #0a84ff; color: #fff; font-size: 15px; font-weight: 600; }
  .error { color: #ff453a; font-size: 13px; margin: 0; }
</style>
</head>
<body>
  <form method="post" action="${ABS_BASE_PATH}/auth/openid/login">
    <h1>BookOrbit sign in</h1>
    <input type="hidden" name="state" value="${escapeHtml(state)}">
    <input name="username" placeholder="Username" autocomplete="username" autocapitalize="none" required>
    <input name="password" type="password" placeholder="Password" autocomplete="current-password" required>
    ${errorHtml}
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
