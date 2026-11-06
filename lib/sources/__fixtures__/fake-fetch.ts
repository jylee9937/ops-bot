/** 정해 둔 응답을 차례로 돌려주고, 받은 요청을 기록한다. */
export function fakeFetch(responses: Array<Response | Error>) {
  const urls: URL[] = [];
  const authorization: Array<string | null> = [];

  const impl: typeof fetch = async (input, init) => {
    urls.push(new URL(String(input)));
    authorization.push(new Headers(init?.headers).get("authorization"));
    if (init?.signal?.aborted) throw init.signal.reason;

    const next = responses.shift();
    if (!next) throw new Error("예상하지 못한 요청");
    if (next instanceof Error) throw next;
    return next;
  };

  return { impl, urls, authorization };
}

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), init);
}
