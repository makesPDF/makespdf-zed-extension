// A local HTTP server that stands in for makesPDF.com in integration tests.
// Records every request and replies from a route table.

import { createServer, type Server } from "node:http";

export interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: any;
}

export interface MockReply {
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer | string;
}

export interface MockRoute {
  method?: string;
  /** Exact request path, e.g. "/api/v1/md". */
  path: string;
  reply: MockReply | ((request: CapturedRequest) => MockReply);
}

export interface MockApi {
  url: string;
  requests: CapturedRequest[];
  requestsFor(path: string): CapturedRequest[];
  close(): Promise<void>;
}

export function startMockApi(routes: MockRoute[]): Promise<MockApi> {
  const requests: CapturedRequest[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let json: any;
      try {
        json = body ? JSON.parse(body) : undefined;
      } catch {
        json = undefined;
      }
      const captured: CapturedRequest = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body,
        json,
      };
      requests.push(captured);

      const route = routes.find(
        (candidate) =>
          candidate.path === captured.path &&
          (!candidate.method || candidate.method === captured.method),
      );
      const reply = route
        ? typeof route.reply === "function"
          ? route.reply(captured)
          : route.reply
        : { status: 404, body: JSON.stringify({ error: "no mock route" }) };

      const payload =
        reply.body === undefined
          ? ""
          : Buffer.isBuffer(reply.body)
            ? reply.body
            : Buffer.from(reply.body);
      res.writeHead(reply.status ?? 200, {
        "Content-Type": "application/json",
        "Content-Length": payload.length,
        ...reply.headers,
      });
      res.end(payload);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no server address");
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        requestsFor: (path) => requests.filter((request) => request.path === path),
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
