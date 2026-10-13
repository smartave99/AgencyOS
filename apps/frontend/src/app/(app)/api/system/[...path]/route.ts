import { NextRequest, NextResponse } from 'next/server';

// The desktop app's System settings (what is running, local AI, where files are kept) talk to the
// launcher that runs AgencyOS on this computer. The launcher's own token stays on this side: a page
// can only ask through here, and only a signed-in administrator on this computer is answered.
const READ = new Set(['status']);
const WRITE = new Set([
  'storage/check',
  'storage/move',
  'storage/cleanup',
  'ai/retry',
  'restart',
]);
const MAX_BODY = 16 * 1024;

const refuse = (status: number, error: string) =>
  NextResponse.json({ error }, { status });

const administrator = async (request: NextRequest) => {
  const auth =
    request.cookies.get('auth')?.value || request.headers.get('auth');
  if (!auth) return false;
  try {
    const res = await fetch(`${process.env.BACKEND_INTERNAL_URL}/user/self`, {
      headers: { auth },
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const user = await res.json();
    return user?.role === 'SUPERADMIN' || user?.role === 'ADMIN';
  } catch {
    return false;
  }
};

/** Only this app's own pages, opened on this computer: never another website, never another host name. */
const fromOwnPage = (request: NextRequest) => {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return false;
  const port = new URL(process.env.FRONTEND_URL || 'http://localhost:4200')
    .port;
  const host = (request.headers.get('host') || '').toLowerCase();
  return host === `localhost:${port}` || host === `127.0.0.1:${port}`;
};

const forward = async (
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
  method: 'GET' | 'POST'
) => {
  const statusUrl = process.env.AGENCYOS_STATUS_URL;
  const token = process.env.AGENCYOS_STATUS_TOKEN;
  if (process.env.AGENCYOS_LOCAL !== 'true' || !statusUrl || !token) {
    return refuse(404, 'Not found');
  }
  const path = (await context.params).path.join('/');
  if (!(method === 'GET' ? READ : WRITE).has(path)) {
    return refuse(404, 'Not found');
  }
  if (!fromOwnPage(request)) return refuse(403, 'Forbidden');
  if (!(await administrator(request))) return refuse(403, 'Forbidden');

  let body: string | undefined;
  if (method === 'POST') {
    body = await request.text();
    if (body.length > MAX_BODY) return refuse(413, 'Request too large');
  }
  try {
    const res = await fetch(`${statusUrl}/api/${path}`, {
      method,
      headers: {
        'X-AgencyOS-Token': token,
        'Content-Type': 'application/json',
      },
      body: method === 'POST' ? body || '{}' : undefined,
      cache: 'no-store',
    });
    return new NextResponse(await res.text(), {
      status: res.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    // The launcher is restarting the app (a move of the files, for one): say so instead of failing.
    return refuse(503, 'AgencyOS is busy. Try again in a moment.');
  }
};

export const GET = (
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) => forward(request, context, 'GET');

export const POST = (
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) => forward(request, context, 'POST');
