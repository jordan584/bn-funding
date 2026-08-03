export interface SeenRequest {
  url: URL;
  init?: RequestInit;
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers }
  });
}

export function queuedFetch(
  responses: Array<Response | Error | ((url: URL, init?: RequestInit) => Response | Promise<Response>)>,
  seenRequests: SeenRequest[]
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    seenRequests.push({ url, ...(init === undefined ? {} : { init }) });
    const next = responses.shift();

    if (next === undefined) {
      throw new Error('Unexpected fetch request');
    }
    if (next instanceof Error) {
      throw next;
    }
    if (typeof next === 'function') {
      return next(url, init);
    }
    return next;
  };
}
